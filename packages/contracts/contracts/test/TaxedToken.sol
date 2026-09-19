// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * An ERC-20 that takes a cut of every transfer. Tests only.
 *
 * Launchpad tokens carry this often enough that the distributor has to cope
 * with meeting one: a "5% tax" token moves 95 of every 100 it is told to move,
 * and a distributor that does not notice credits recipients for the full
 * amount and pays them less, permanently and invisibly.
 *
 * Deliberately not a burn or a reflection — just the simplest shape that
 * delivers less than asked, which is the only property under test.
 */
contract TaxedToken is ERC20 {
    uint256 public constant TAX_BPS = 500; // 5%

    constructor() ERC20("Taxed", "TAX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        // Mints and burns pass through untouched; only real transfers are taxed.
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        uint256 tax = (value * TAX_BPS) / 10_000;
        super._update(from, address(0xdead), tax);
        super._update(from, to, value - tax);
    }
}
