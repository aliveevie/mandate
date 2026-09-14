import { parseAbi } from "viem";

/** Mock venue + asset used by tests and the quickstart (contracts/test/mocks). */
export const venueAbi = parseAbi([
  "function buy(address token, uint256 amount)",
  "function noop()",
  "function forbidden()",
  "function payout(address token, address to, uint256 amount)",
  "function pull(address token, address from, uint256 amount)",
  "error VenueRejected(uint256 code)",
]);

export const erc20Abi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
