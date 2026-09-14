// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BaseTest, Mandate, MandateRegistry, MandateExecutor, RiskBreaker, MockERC20, MockVenue} from "../BaseTest.sol";

/// @notice Drives the agent, the market and the principal against one mandate with the breaker enabled.
contract MandateHandler is Test {
    MandateRegistry public registry;
    MandateExecutor public executor;
    RiskBreaker public breaker;
    MockERC20 public asset;
    MockVenue public venue;
    address public account;
    address public agentKey;
    bytes32 public h;
    Mandate public mandateMeta; // for caps

    uint256 public ghostSpent;
    uint256 public ghostBlockSpent;
    uint256 public ghostBlock;
    bool public ghostRevoked;
    uint256 public successes;
    uint256 public execsAfterRevoke;
    uint256 public execsWhileTripped;
    uint256 public execsWithBadTarget;

    constructor(
        MandateRegistry _registry,
        MandateExecutor _executor,
        RiskBreaker _breaker,
        MockERC20 _asset,
        MockVenue _venue,
        address _account,
        address _agentKey,
        bytes32 _h
    ) {
        registry = _registry;
        executor = _executor;
        breaker = _breaker;
        asset = _asset;
        venue = _venue;
        account = _account;
        agentKey = _agentKey;
        h = _h;
    }

    function execute(uint256 kind, uint256 amount) external {
        kind = bound(kind, 0, 4);
        amount = bound(amount, 0, 300e18);
        address target = address(venue);
        bytes memory data;
        bool allowed = true;
        if (kind == 0) {
            data = abi.encodeCall(MockVenue.buy, (address(asset), amount));
        } else if (kind == 1) {
            data = abi.encodeCall(MockVenue.noop, ());
        } else if (kind == 2) {
            data = abi.encodeCall(MockVenue.forbidden, ());
            allowed = false;
        } else if (kind == 3) {
            data = abi.encodeCall(MockVenue.buy, (address(asset), amount / 2)); // spends less than declared
        } else {
            target = address(asset); // not whitelisted at all
            data = abi.encodeWithSignature("transfer(address,uint256)", agentKey, amount);
            allowed = false;
        }

        bool trippedBefore = breaker.isTripped(h);
        uint256 before = asset.balanceOf(account);
        vm.prank(agentKey);
        try executor.execute(h, target, data, amount) {
            successes++;
            if (ghostRevoked) execsAfterRevoke++;
            if (trippedBefore) execsWhileTripped++;
            if (!allowed) execsWithBadTarget++;
            uint256 after_ = asset.balanceOf(account);
            uint256 spent = before > after_ ? before - after_ : 0;
            if (block.number != ghostBlock) {
                ghostBlock = block.number;
                ghostBlockSpent = 0;
            }
            ghostBlockSpent += spent;
            ghostSpent += spent;
        } catch {}
    }

    function roll(uint256 n) external {
        vm.roll(block.number + bound(n, 1, 15));
    }

    function marketGain(uint256 amount) external {
        amount = bound(amount, 0, 150e18);
        uint256 inv = asset.balanceOf(address(venue));
        if (amount > inv) amount = inv;
        venue.payout(address(asset), account, amount);
    }

    function marketLoss(uint256 amount) external {
        amount = bound(amount, 0, 150e18);
        uint256 bal = asset.balanceOf(account);
        if (amount > bal) amount = bal;
        venue.pull(address(asset), account, amount);
    }

    function checkpoint() external {
        breaker.checkpoint(h);
    }

    function resetPeak(uint256 seed) external {
        if (seed % 7 != 0) return; // rare
        vm.prank(account);
        breaker.resetPeak(h);
    }

    function revoke(uint256 seed) external {
        if (ghostRevoked || seed % 13 != 0) return; // rare, once
        vm.prank(account);
        registry.revoke(h);
        ghostRevoked = true;
    }
}

contract MandateInvariants is BaseTest {
    MandateHandler handler;
    bytes32 h;

    function setUp() public override {
        super.setUp();
        Mandate memory m = _defaultMandate();
        m.maxDrawdownBps = 3_000;
        h = _grant(m);
        handler = new MandateHandler(registry, executor, breaker, asset, venue, address(account), agentKey, h);
        targetContract(address(handler));
    }

    /// Property 1: lifetime spend never exceeds spendCap, and accounting matches real outflow.
    function invariant_lifetimeSpendWithinCap() public view {
        assertLe(handler.ghostSpent(), SPEND_CAP);
        assertEq(registry.getState(h).spent, handler.ghostSpent());
        assertLe(registry.getState(h).spent, SPEND_CAP);
    }

    /// Property 1: per-block spend never exceeds perBlockCap.
    function invariant_perBlockSpendWithinCap() public view {
        assertLe(handler.ghostBlockSpent(), PER_BLOCK_CAP);
        assertLe(registry.getState(h).spentThisBlock, PER_BLOCK_CAP);
    }

    /// Property 2: no execution ever hits a non-whitelisted target/selector.
    function invariant_onlyWhitelistedCalls() public view {
        assertEq(handler.execsWithBadTarget(), 0);
        assertEq(asset.balanceOf(agentKey), 0);
    }

    /// Property 3: nothing executes after revocation.
    function invariant_noExecutionAfterRevoke() public view {
        assertEq(handler.execsAfterRevoke(), 0);
    }

    /// Property 4: breaker tripped => zero executions until re-armed.
    function invariant_noExecutionWhileTripped() public view {
        assertEq(handler.execsWhileTripped(), 0);
    }

    /// Deterministic smoke run: proves the handler reaches real executions, trips and re-arms.
    function test_handlerSmoke() public {
        bool sawTrip;
        for (uint256 i; i < 400; ++i) {
            uint256 seed = uint256(keccak256(abi.encode(i)));
            uint256 op = seed % 8;
            if (op < 4) handler.execute(seed >> 8, (seed >> 16) % 300e18);
            else if (op == 4) handler.roll(seed >> 8);
            else if (op == 5) handler.marketGain((seed >> 8) % 150e18);
            else if (op == 6) handler.marketLoss((seed >> 8) % 150e18);
            else handler.checkpoint();
            if (breaker.isTripped(h)) sawTrip = true;
        }
        assertGt(handler.successes(), 0);
        assertGt(handler.ghostSpent(), 0);
        assertTrue(sawTrip);
        assertEq(handler.execsWhileTripped(), 0);
        assertEq(handler.execsWithBadTarget(), 0);
        assertLe(handler.ghostSpent(), SPEND_CAP);
    }

    function invariant_callSummary() public view {
        // keeps the handler reachable in the corpus; no assertion beyond sanity
        assertLe(handler.successes(), type(uint256).max);
    }
}
