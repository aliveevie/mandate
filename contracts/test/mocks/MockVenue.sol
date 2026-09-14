// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Like {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @notice Stand-in for a DEX / perp venue. `buy` pulls `asset` from the caller (a spend).
contract MockVenue {
    error VenueRejected(uint256 code);

    uint256 public noopCalls;

    function buy(address token, uint256 amount) external {
        IERC20Like(token).transferFrom(msg.sender, address(this), amount);
    }

    function noop() external {
        noopCalls++;
    }

    function forbidden() external {}

    function fail(uint256 code) external pure {
        revert VenueRejected(code);
    }

    // ---- test-only market simulation (venue holds approvals / inventory) ----
    function payout(address token, address to, uint256 amount) external {
        IERC20Like(token).transfer(to, amount);
    }

    function pull(address token, address from, uint256 amount) external {
        IERC20Like(token).transferFrom(from, address(this), amount);
    }
}
