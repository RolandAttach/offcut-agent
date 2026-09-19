// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * A plain ERC-20 for tests only.
 *
 * Not the OFFCUT token and not a template for it: it mints freely to anyone who
 * asks, which is exactly what a test wants and exactly what a real token must
 * never do. It lives under contracts/test/ so it cannot be mistaken for
 * something deployable.
 */
contract TestToken is ERC20 {
    constructor() ERC20("Test", "TEST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
