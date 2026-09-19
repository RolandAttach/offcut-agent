// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * OFFCUT rewards: a cumulative Merkle distributor.
 *
 * ---------------------------------------------------------------------------
 * What this does, and why it is shaped this way
 * ---------------------------------------------------------------------------
 *
 * Who earned what is decided OFF-CHAIN, from the memory store's own audit log,
 * and arrives here as a single 32-byte Merkle root. That split is the whole
 * design, and it buys three things:
 *
 *   - The rules for earning can change in a minute without touching a contract
 *     that holds money. Free accounts mean no formula is farm-proof; the real
 *     defence is being able to fix the rules the moment a farm appears, and to
 *     review a period before publishing it.
 *   - The chain does the one thing a chain is good at — proving a payout was
 *     authorised — and nothing else. Less code holding value is less to break.
 *   - A root can be published every ten minutes for a few cents, because the
 *     cost does not scale with the number of recipients.
 *
 * Roots are CUMULATIVE: each one carries the total an address has ever earned,
 * not the amount for that window. So a new root never invalidates an unclaimed
 * one, a recipient can ignore a hundred roots and claim once, and a claim is
 * "pay me the difference between what I have earned and what I have taken".
 * A per-window design would strand anyone who did not claim in time, which with
 * a ten-minute cadence would be almost everyone.
 *
 * ---------------------------------------------------------------------------
 * Who can do what — stated plainly because it matters
 * ---------------------------------------------------------------------------
 *
 * This contract is NOT trustless, and the site says so rather than implying
 * otherwise. Two roles, deliberately separated:
 *
 *   publisher  sets roots. Nothing else. This key lives on a server, signing
 *              every ten minutes, so it is the one most likely to be stolen —
 *              and a thief who holds it can misdirect FUTURE rewards but
 *              cannot withdraw, cannot upgrade, and cannot take the balance.
 *   owner      funds, withdraws, upgrades, pauses, changes the publisher.
 *              Belongs on a hardware wallet or a multisig. An owner can take
 *              everything in here; anyone reading the page is told that.
 *
 * The withdrawal function exists because unclaimed rewards must be recoverable
 * and a treasury has to be managed. It is the same function that would let an
 * owner walk away with the pool. Both are true, and pretending only the first
 * is true is what makes a project a rug in retrospect.
 */
contract OffcutRewards is
    Initializable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    /// The ERC-20 paid out. Settable once, and only while nothing is owed.
    IERC20 public token;

    /// The only key allowed to publish roots.
    address public publisher;

    /// The current cumulative root. Zero until the first publication.
    bytes32 public merkleRoot;

    /// Monotonic counter, so a client can tell one root from the next.
    uint256 public rootIndex;

    /// When the current root was published, for display and for staleness.
    uint256 public rootPublishedAt;

    /// Total ever claimed, per address. Cumulative amounts are measured against it.
    mapping(address => uint256) public claimed;

    /// Sum of every claim ever paid. Not derivable from a balance that can be topped up.
    uint256 public totalClaimed;

    event RootPublished(uint256 indexed index, bytes32 root, uint256 publishedAt);
    event Claimed(address indexed account, uint256 amount, uint256 cumulative);
    event PublisherChanged(address indexed previous, address indexed next);
    event TokenSet(address indexed token);
    event Withdrawn(address indexed to, uint256 amount);

    error NotPublisher();
    error ZeroAddress();
    error TokenAlreadySet();
    error TokenNotSet();
    error NoRoot();
    error InvalidProof();
    error NothingToClaim();
    error InsufficientBalance(uint256 requested, uint256 available);
    error TransferShortfall(uint256 sent, uint256 delivered);

    modifier onlyPublisher() {
        if (msg.sender != publisher) revert NotPublisher();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // An implementation contract that can still be initialised is an
        // implementation someone else can take over. Locking it is the standard
        // guard and costs nothing.
        _disableInitializers();
    }

    /**
     * @param owner_     funds, withdraws, upgrades. Hardware wallet or multisig.
     * @param publisher_ the server key. Roots only.
     * @param token_     the ERC-20 to pay in, or address(0) if it does not exist
     *                   yet — rewards accrue in published roots either way and
     *                   become claimable once `setToken` is called.
     */
    function initialize(address owner_, address publisher_, address token_) external initializer {
        if (owner_ == address(0) || publisher_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Ownable2Step_init();
        __Pausable_init();
        // No __UUPSUpgradeable_init(): OpenZeppelin v5 removed it. The mixin
        // holds no storage of its own, so there is nothing left to initialise —
        // calling it is a compile error rather than a no-op.

        publisher = publisher_;
        emit PublisherChanged(address(0), publisher_);

        if (token_ != address(0)) {
            token = IERC20(token_);
            emit TokenSet(token_);
        }
    }

    // -----------------------------------------------------------------------
    // Publishing
    // -----------------------------------------------------------------------

    /**
     * Publishes the cumulative root for everyone who has earned so far.
     *
     * A leaf is keccak256(keccak256(abi.encode(account, cumulativeAmount))).
     * Hashed TWICE on purpose: a singly-hashed 64-byte leaf can be passed off
     * as an internal node, which is how a proof for an amount nobody earned
     * gets forged. `abi.encode` rather than `encodePacked` for the same family
     * of reason — fixed-width fields cannot be re-split. The off-chain builder
     * must also sort each pair before hashing, because OpenZeppelin's verifier
     * does; the test suite pins that agreement so the two cannot drift.
     *
     * Deliberately permitted: republishing a root that lowers what an address
     * is owed. A farm found after the fact can be cut off, and since claims are
     * measured against `claimed`, an address that already took more than the
     * new root allows simply has nothing further to take — it is never asked
     * for money back, because clawing back is not something this can do.
     */
    function publishRoot(bytes32 root) external onlyPublisher whenNotPaused {
        if (root == bytes32(0)) revert NoRoot();

        merkleRoot = root;
        rootPublishedAt = block.timestamp;
        unchecked {
            rootIndex += 1;
        }

        emit RootPublished(rootIndex, root, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // Claiming
    // -----------------------------------------------------------------------

    /**
     * Pays an account the difference between what it has earned and taken.
     *
     * Callable by anyone for anyone: the proof already names the recipient and
     * the amount, funds can only go to `account`, so a third party paying the
     * gas is a courtesy rather than a hole. It is also what lets the site offer
     * "claim for me" later without a second contract.
     */
    function claim(address account, uint256 cumulativeAmount, bytes32[] calldata proof)
        external
        whenNotPaused
    {
        if (address(token) == address(0)) revert TokenNotSet();
        if (merkleRoot == bytes32(0)) revert NoRoot();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) revert InvalidProof();

        uint256 alreadyClaimed = claimed[account];
        if (cumulativeAmount <= alreadyClaimed) revert NothingToClaim();

        uint256 amount;
        unchecked {
            amount = cumulativeAmount - alreadyClaimed;
        }

        uint256 available = token.balanceOf(address(this));
        if (amount > available) revert InsufficientBalance(amount, available);

        // Written before the transfer: the state this contract reasons about is
        // settled before control can leave it.
        claimed[account] = cumulativeAmount;
        totalClaimed += amount;

        /**
         * Sent, then checked it arrived.
         *
         * A token that takes a cut on transfer — a launchpad tax, a reflection,
         * a deflationary burn — delivers less than it was asked to move, while
         * `claimed` above has already recorded the full amount. Every recipient
         * would be quietly short, and the shortfall would never be visible in
         * any number this contract reports.
         *
         * Reverting makes that fail on the first claim rather than on all of
         * them. The fix is at the token: exempt this address from the fee. The
         * OFFCUT token is being launched through a venue whose tokens sometimes
         * carry exactly this behaviour, which is why the check is here rather
         * than in a comment saying it should not happen.
         */
        uint256 balanceBefore = token.balanceOf(account);
        token.safeTransfer(account, amount);
        uint256 delivered = token.balanceOf(account) - balanceBefore;
        if (delivered < amount) revert TransferShortfall(amount, delivered);

        emit Claimed(account, amount, cumulativeAmount);
    }

    /// What `account` could take right now, given a valid proof for `cumulativeAmount`.
    function claimable(address account, uint256 cumulativeAmount) external view returns (uint256) {
        uint256 alreadyClaimed = claimed[account];
        return cumulativeAmount > alreadyClaimed ? cumulativeAmount - alreadyClaimed : 0;
    }

    // -----------------------------------------------------------------------
    // Owner
    // -----------------------------------------------------------------------

    /**
     * Names the token, once.
     *
     * Once, because changing it after anyone has claimed would make `claimed`
     * meaningless — the same number would stand for amounts of two different
     * assets. The token is expected to arrive after this contract does, which
     * is why it is not required at initialisation.
     */
    function setToken(address token_) external onlyOwner {
        if (token_ == address(0)) revert ZeroAddress();
        if (address(token) != address(0)) revert TokenAlreadySet();

        token = IERC20(token_);
        emit TokenSet(token_);
    }

    function setPublisher(address publisher_) external onlyOwner {
        if (publisher_ == address(0)) revert ZeroAddress();

        address previous = publisher;
        publisher = publisher_;

        emit PublisherChanged(previous, publisher_);
    }

    /**
     * Takes tokens out of the contract.
     *
     * This is the function that recovers unclaimed rewards, and it is also the
     * function that would let an owner empty the pool. There is no version of
     * this that is only the first thing. The page says so in as many words.
     */
    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (address(token) == address(0)) revert TokenNotSet();

        uint256 available = token.balanceOf(address(this));
        if (amount > available) revert InsufficientBalance(amount, available);

        token.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /// Stops publishing and claiming. Does not stop the owner withdrawing.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// Storage gap, so a later version can add state without moving what exists.
    uint256[40] private __gap;
}
