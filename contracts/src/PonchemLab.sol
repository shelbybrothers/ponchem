// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DataStore} from "./DataStore.sol";
import {PonchemEngine} from "./PonchemEngine.sol";
import {PonchemCheck} from "./PonchemCheck.sol";

/// @title PonchemLab
/// @notice The on-chain record of Ponchem, a computer-aided drug design lab from Pons Lab on Robinhood Chain.
///
///         The owner registers cancer targets (a binding pocket taken from an RCSB Protein Data Bank entry) and
///         plant compounds (a heavy-atom topology). Each blob is checked by PonchemCheck, hashed, compared with the
///         hash the pipeline recorded, and stored as code in its own data contract (the pocket in its scan form,
///         a lossless transform of the registered bytes).
///
///         A docking test: anyone submits a pose, the position of every heavy atom of a ligand inside a target's
///         box. The contract proves the geometry (atom count, box, bond lengths, 1-3 distances, clash floor)
///         against the registered topology and recomputes the estimated binding free energy with the integer
///         Vina-style scorer of SPEC-ENGINE.md against the registered pocket. The run is stored with the wallet,
///         the score and the hash of the pose; the event carries the whole pose so the site rebuilds every run
///         from logs. A test is paid to the treasury, in ETH (runFee) or in the lab token (runPrice), the payer's
///         choice. Anyone can review a run they did not record: one to five stars and a note.
///
///         Prize pools: anyone can fund a target's pool for the current epoch. Epochs are `epochLength` long from
///         `genesis`. Once an epoch has ended anyone can settle it: the wallet that holds the epoch's best (lowest)
///         score on that target receives the pool minus the lab fee, which goes to the treasury; an epoch with no
///         run rolls its pool into the next one. Settling is in epoch order per target, and settle(target, e)
///         settles every unsettled epoch up to e in one call.
///
///         Safety: transfers happen last and with a gas allowance; a receiver that refuses is credited in `owed`
///         and withdraws later; nothing a receiver returns is copied into memory. No proxy, no upgrade, two-step
///         ownership.
contract PonchemLab is PonchemEngine {
    // ------------------------------------------------------------------ constants

    uint16 public constant MAX_FEE_BPS = 1000;
    uint256 public constant MAX_NAME = 96;
    uint256 public constant MAX_KEY = 32;
    uint256 public constant MAX_NOTE = 280;
    uint256 private constant BPS = 10_000;
    /// @dev enough for a smart wallet's receive hook, too little to grief a settle
    uint256 private constant PAY_GAS = 100_000;
    uint8 public constant PAY_ETH = 0;
    uint8 public constant PAY_TOKEN = 1;

    // ---------------------------------------------------------------------- types

    struct Target {
        string pdbId;
        string name;
        uint32 cancerBits;
        address data;
        bytes32 hash;
        uint16 atoms;
    }

    struct Ligand {
        string key;
        string name;
        address data;
        bytes32 hash;
        uint8 atoms;
        uint8 nrot;
    }

    /// @dev two storage slots: wallet, ids, score and time share the first, the pose hash is the second
    struct Run {
        address wallet;
        uint16 targetId;
        uint16 ligandId;
        int32 scoreMilli;
        uint32 time;
        bytes32 poseHash;
    }

    struct Stats {
        uint64 runs;
        int32 best;
        uint32 reviewsGiven;
        uint32 reviewsReceived;
        uint32 starsReceived;
        uint256 prizes;
    }

    struct ReviewStats {
        uint32 count;
        uint32 starSum;
    }

    struct Review {
        uint8 stars;
        uint64 time;
    }

    // -------------------------------------------------------------------- storage

    PonchemCheck public immutable check;
    uint64 public immutable genesis;
    uint64 public immutable epochLength;

    address public owner;
    address public pendingOwner;
    address public treasury;
    uint16 public feeBps;
    /// @notice what a docking test costs in ETH (wei), paid to the treasury
    uint256 public runFee;
    /// @notice what a docking test costs in the lab token (its smallest unit), paid to the treasury
    uint256 public runPrice;
    /// @notice the lab token ($PONCHEM); zero until it launches
    address public token;
    bool public ethAllowed;
    bool public tokenAllowed;

    /// @notice the frozen scoring tables, stored as code; zero until setTables
    address public tables;

    uint16 public targetCount;
    uint16 public ligandCount;
    uint256 public runCount;

    mapping(uint16 => Target) private _targets;
    mapping(uint16 => Ligand) private _ligands;
    mapping(uint256 => Run) private _runs;
    mapping(address => Stats) private _stats;
    mapping(uint256 => ReviewStats) private _reviewStats;
    mapping(uint256 => mapping(address => Review)) private _reviews;

    /// @notice run id holding the lowest score on a target (0 = none)
    mapping(uint16 => uint256) public bestOf;
    /// @notice run id holding the lowest score on a target during an epoch (0 = none)
    mapping(uint16 => mapping(uint32 => uint256)) public bestOfEpoch;
    /// @notice run id holding the lowest score for a target and ligand pair (0 = none)
    mapping(uint16 => mapping(uint16 => uint256)) public bestPair;

    /// @notice ETH that sponsors put into a target's pool during an epoch
    mapping(uint16 => mapping(uint32 => uint256)) public poolAt;
    /// @notice ETH rolled over from settled epochs that had no run, waiting for the next epoch with one
    mapping(uint16 => uint256) public carry;
    /// @notice the first epoch of a target that is not settled yet
    mapping(uint16 => uint32) public nextSettle;
    /// @notice ETH held for pools that are not paid out yet (poolAt of unsettled epochs plus carry)
    uint256 public totalHeld;

    /// @notice payments a wallet refused, waiting for withdraw()
    mapping(address => uint256) public owed;
    uint256 public totalOwed;

    uint256 private _lock = 1;

    // --------------------------------------------------------------------- events

    event TargetRegistered(uint16 indexed id, string pdbId, string name, address data, bytes32 hash);
    event LigandRegistered(uint16 indexed id, string key, string name, address data, bytes32 hash);
    event RunScored(
        uint256 indexed runId,
        address indexed wallet,
        uint16 indexed targetId,
        uint16 ligandId,
        int32 scoreMilli,
        uint32 epoch,
        int16[] pose
    );
    event Paid(uint256 indexed runId, address indexed wallet, uint8 method, uint256 amount);
    event Reviewed(uint256 indexed runId, address indexed reviewer, uint8 stars, string note);
    event Funded(uint16 indexed targetId, address indexed from, uint256 amount, uint256 pool);
    event Settled(uint16 indexed targetId, uint32 indexed epoch, address winner, uint256 runId, uint256 amount);
    event Rolled(uint16 indexed targetId, uint32 indexed epoch, uint256 pool);
    event TablesSet(address data, bytes32 hash);
    event PricesSet(uint256 runFee, uint256 runPrice);
    event PaymentOptionsSet(bool ethAllowed, bool tokenAllowed);
    event FeeBpsSet(uint16 feeBps);
    event TreasurySet(address treasury);
    event TokenSet(address token);
    event Owed(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    // --------------------------------------------------------------------- errors

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error FeeTooHigh();
    error BadEpochLength();
    error NoTables();
    error TablesAlreadySet();
    error BadTables();
    error HashMismatch();
    error BadName();
    error TooMany();
    error NoTarget();
    error NoLigand();
    error NoRun();
    error WrongFee();
    error PaymentNotAllowed();
    error TokenRequired();
    error TokenPaymentFailed();
    error BadPose(uint8 reason);
    error ScoreOverflow();
    error OwnRun();
    error BadStars();
    error NoteTooLong();
    error NoValue();
    error NotEnded();
    error AlreadySettled();
    error NoRuns();
    error NothingOwed();
    error TransferFailed();
    error Reentered();

    // ------------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentered();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param check_ the PonchemCheck contract deployed for this lab
    /// @param owner_ owner (registers targets and ligands, sets prices); the deployer if it will register
    /// @param treasury_ receives every test payment and the lab fee of every settled prize
    /// @param feeBps_ lab fee in basis points of a settled pool, at most 1000
    /// @param runFee_ what a docking test costs in ETH, in wei
    /// @param runPrice_ what a docking test costs in the lab token, in its smallest unit
    /// @param epochLength_ seconds per prize epoch, 1 hour to 365 days; the first epoch starts now
    constructor(
        PonchemCheck check_,
        address owner_,
        address treasury_,
        uint16 feeBps_,
        uint256 runFee_,
        uint256 runPrice_,
        uint64 epochLength_
    ) {
        if (owner_ == address(0) || treasury_ == address(0) || address(check_) == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (epochLength_ < 1 hours || epochLength_ > 365 days) revert BadEpochLength();
        check = check_;
        owner = owner_;
        treasury = treasury_;
        feeBps = feeBps_;
        runFee = runFee_;
        runPrice = runPrice_;
        ethAllowed = true;
        tokenAllowed = true;
        genesis = uint64(block.timestamp);
        epochLength = epochLength_;
        emit OwnershipTransferred(address(0), owner_);
        emit TreasurySet(treasury_);
        emit FeeBpsSet(feeBps_);
        emit PricesSet(runFee_, runPrice_);
        emit PaymentOptionsSet(true, true);
    }

    // ------------------------------------------------------------------ the science

    /// @notice Record a docking test paid in ETH: msg.value must equal runFee. The pose is the position of every
    ///         heavy atom of the ligand, in topology order, as int16 centi-angstrom relative to the target's box
    ///         centre.
    /// @return runId the 1-based id of the run
    /// @return scoreMilli the estimated binding free energy in milli-kcal/mol (negative is good)
    function submitRun(uint16 targetId, uint16 ligandId, int16[] calldata pose)
        external
        payable
        nonReentrant
        returns (uint256 runId, int32 scoreMilli)
    {
        return _submit(targetId, ligandId, pose, false);
    }

    /// @notice Record a docking test, paid in ETH (payWithToken false, msg.value == runFee) or in the lab token
    ///         (payWithToken true, msg.value == 0, runPrice taken with transferFrom). Either way the payment goes
    ///         to the treasury.
    function submitRun(uint16 targetId, uint16 ligandId, int16[] calldata pose, bool payWithToken)
        external
        payable
        nonReentrant
        returns (uint256 runId, int32 scoreMilli)
    {
        return _submit(targetId, ligandId, pose, payWithToken);
    }

    function _submit(uint16 targetId, uint16 ligandId, int16[] calldata pose, bool payWithToken)
        private
        returns (uint256 runId, int32 scoreMilli)
    {
        uint256 amount;
        if (payWithToken) {
            if (msg.value != 0) revert WrongFee();
            if (!tokenAllowed) revert PaymentNotAllowed();
            if (token == address(0)) revert TokenRequired();
            amount = runPrice;
        } else {
            if (!ethAllowed) revert PaymentNotAllowed();
            if (msg.value != runFee) revert WrongFee();
            amount = msg.value;
        }
        // the pose hash is the keccak256 of the canonical 6N pose bytes (SPEC-ENGINE.md 4.7)
        bytes32 poseHash;
        (scoreMilli, poseHash) = _score(targetId, ligandId, pose);
        uint32 epoch = currentEpoch();
        runId = ++runCount;
        _runs[runId] = Run({
            wallet: msg.sender,
            targetId: targetId,
            ligandId: ligandId,
            scoreMilli: scoreMilli,
            time: uint32(block.timestamp),
            poseHash: poseHash
        });
        if (_lower(bestOf[targetId], scoreMilli)) bestOf[targetId] = runId;
        if (_lower(bestOfEpoch[targetId][epoch], scoreMilli)) bestOfEpoch[targetId][epoch] = runId;
        if (_lower(bestPair[targetId][ligandId], scoreMilli)) bestPair[targetId][ligandId] = runId;
        Stats storage s = _stats[msg.sender];
        if (s.runs == 0 || scoreMilli < s.best) s.best = scoreMilli;
        s.runs += 1;
        emit RunScored(runId, msg.sender, targetId, ligandId, scoreMilli, epoch, pose);
        emit Paid(runId, msg.sender, payWithToken ? PAY_TOKEN : PAY_ETH, amount);
        // the payment last: nothing after it depends on the receiver
        if (payWithToken) {
            _takeToken(msg.sender, amount);
        } else if (amount != 0) {
            _pay(treasury, amount);
        }
    }

    /// @notice The same geometry proof and score as submitRun, with the same BadPose reasons, free of charge (the
    ///         payment checks are not run). For eth_call before sending.
    function quote(uint16 targetId, uint16 ligandId, int16[] calldata pose) external view returns (int32 scoreMilli) {
        (scoreMilli,) = _score(targetId, ligandId, pose);
    }

    function _score(uint16 targetId, uint16 ligandId, int16[] calldata pose) private view returns (int32, bytes32) {
        Target storage t = _target(targetId);
        Ligand storage l = _ligand(ligandId);
        address tab = tables;
        if (tab == address(0)) revert NoTables();
        (uint256 code, int256 score, bytes32 poseHash,) = _evaluate(t.data, l.data, tab, pose);
        if (code != OK) revert BadPose(uint8(code));
        if (score < type(int32).min || score > type(int32).max) revert ScoreOverflow();
        return (int32(score), poseHash);
    }

    // -------------------------------------------------------------------- reviews

    /// @notice Review a docking test you did not record: one to five stars and a note of at most 280 bytes (the
    ///         note lives in the event). A second review of the same run by the same wallet replaces the first.
    function reviewRun(uint256 runId, uint8 stars, string calldata note) external {
        if (runId == 0 || runId > runCount) revert NoRun();
        if (stars == 0 || stars > 5) revert BadStars();
        if (bytes(note).length > MAX_NOTE) revert NoteTooLong();
        address author = _runs[runId].wallet;
        if (author == msg.sender) revert OwnRun();
        Review storage r = _reviews[runId][msg.sender];
        ReviewStats storage rs = _reviewStats[runId];
        Stats storage a = _stats[author];
        if (r.stars == 0) {
            rs.count += 1;
            _stats[msg.sender].reviewsGiven += 1;
            a.reviewsReceived += 1;
        } else {
            rs.starSum -= r.stars;
            a.starsReceived -= r.stars;
        }
        rs.starSum += stars;
        a.starsReceived += stars;
        r.stars = stars;
        r.time = uint64(block.timestamp);
        emit Reviewed(runId, msg.sender, stars, note);
    }

    function reviewStats(uint256 runId) external view returns (uint32 count, uint32 starSum) {
        ReviewStats storage rs = _reviewStats[runId];
        return (rs.count, rs.starSum);
    }

    function reviewOf(uint256 runId, address wallet) external view returns (uint8 stars, uint64 time) {
        Review storage r = _reviews[runId][wallet];
        return (r.stars, r.time);
    }

    // -------------------------------------------------------------------- money

    /// @notice Add ETH to a target's prize pool for the current epoch. Anyone may sponsor a target.
    function fund(uint16 targetId) external payable nonReentrant {
        _target(targetId);
        if (msg.value == 0) revert NoValue();
        uint32 epoch = currentEpoch();
        poolAt[targetId][epoch] += msg.value;
        totalHeld += msg.value;
        emit Funded(targetId, msg.sender, msg.value, pool(targetId));
    }

    /// @notice Settle every unsettled epoch of a target up to `epoch`, in order. `epoch` must have ended. An epoch
    ///         with a run pays its pool (plus anything rolled into it) to the wallet holding the epoch's best
    ///         score, minus the lab fee at today's feeBps, which goes to the treasury. An epoch without a run
    ///         rolls its pool forward. Reverts with NoRuns when nothing in the range has a run and nothing new
    ///         accrued in it (there is nothing to settle).
    function settle(uint16 targetId, uint32 epoch) external nonReentrant {
        _target(targetId);
        if (epoch >= currentEpoch()) revert NotEnded();
        uint32 next = nextSettle[targetId];
        if (epoch < next) revert AlreadySettled();
        uint256 count = uint256(epoch) - uint256(next) + 1;
        address[] memory to = new address[](count);
        uint256[] memory amounts = new uint256[](count);
        uint256 paid = 0;
        uint256 fees = 0;
        uint256 rolled = carry[targetId];
        bool moved = false;
        for (uint32 e = next; e <= epoch; e++) {
            uint256 accrued = poolAt[targetId][e];
            if (accrued != 0) moved = true;
            uint256 amount = rolled + accrued;
            uint256 best = bestOfEpoch[targetId][e];
            if (best == 0) {
                rolled = amount;
                emit Rolled(targetId, e, amount);
                continue;
            }
            moved = true;
            rolled = 0;
            uint256 fee = (amount * feeBps) / BPS;
            uint256 prize = amount - fee;
            address winner = _runs[best].wallet;
            fees += fee;
            totalHeld -= amount;
            _stats[winner].prizes += prize;
            to[paid] = winner;
            amounts[paid] = prize;
            paid += 1;
            emit Settled(targetId, e, winner, best, prize);
        }
        if (!moved) revert NoRuns();
        carry[targetId] = rolled;
        nextSettle[targetId] = epoch + 1;
        for (uint256 i = 0; i < paid; i++) {
            if (amounts[i] != 0) _pay(to[i], amounts[i]);
        }
        if (fees != 0) _pay(treasury, fees);
    }

    /// @notice Collect payments this wallet refused when they were first sent.
    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        emit Withdrawn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------------- views

    function currentEpoch() public view returns (uint32) {
        return uint32((block.timestamp - genesis) / epochLength);
    }

    function epochStart(uint32 epoch) external view returns (uint64) {
        return genesis + uint64(epoch) * epochLength;
    }

    function target(uint16 id)
        external
        view
        returns (string memory pdbId, string memory name, uint32 cancerBits, address data, bytes32 hash, uint16 atoms)
    {
        Target storage t = _target(id);
        return (t.pdbId, t.name, t.cancerBits, t.data, t.hash, t.atoms);
    }

    function ligand(uint16 id)
        external
        view
        returns (string memory key, string memory name, address data, bytes32 hash, uint8 atoms, uint8 nrot)
    {
        Ligand storage l = _ligand(id);
        return (l.key, l.name, l.data, l.hash, l.atoms, l.nrot);
    }

    function run(uint256 id)
        external
        view
        returns (address wallet, uint16 targetId, uint16 ligandId, int32 scoreMilli, uint32 epoch, uint64 time, bytes32 poseHash)
    {
        if (id == 0 || id > runCount) revert NoRun();
        Run storage r = _runs[id];
        epoch = uint32((uint256(r.time) - genesis) / epochLength);
        return (r.wallet, r.targetId, r.ligandId, r.scoreMilli, epoch, r.time, r.poseHash);
    }

    /// @notice What the best wallet of the current epoch would take before the lab fee if nothing more came in:
    ///         this epoch's own accrual plus everything that rolls into it from earlier unsettled epochs without
    ///         a run (and the carry). Zero for a target that does not exist.
    function pool(uint16 targetId) public view returns (uint256) {
        if (targetId == 0 || targetId > targetCount) return 0;
        uint32 cur = currentEpoch();
        uint256 rolled = carry[targetId];
        for (uint32 e = nextSettle[targetId]; e < cur; e++) {
            rolled = bestOfEpoch[targetId][e] == 0 ? rolled + poolAt[targetId][e] : 0;
        }
        return rolled + poolAt[targetId][cur];
    }

    /// @notice A wallet's record: runs recorded, its lowest score (meaningful when runs > 0), prizes won in wei,
    ///         reviews written, reviews received on its runs and the stars they carry.
    function stats(address wallet)
        external
        view
        returns (uint64 runs, int32 best, uint256 prizes, uint32 reviewsGiven, uint32 reviewsReceived, uint32 starsReceived)
    {
        Stats storage s = _stats[wallet];
        return (s.runs, s.best, s.prizes, s.reviewsGiven, s.reviewsReceived, s.starsReceived);
    }

    // ---------------------------------------------------------------------- owner

    /// @notice Store the frozen scoring tables (13,010 bytes, keccak256 TABLES_HASH). Once, before the first run.
    function setTables(bytes calldata blob) external onlyOwner {
        if (tables != address(0)) revert TablesAlreadySet();
        if (blob.length != TABLES_SIZE || keccak256(blob) != TABLES_HASH) revert BadTables();
        address data = DataStore.write(blob);
        tables = data;
        emit TablesSet(data, TABLES_HASH);
    }

    /// @notice Register a target: its pocket bytes are checked against SPEC-ENGINE.md section 5, hashed, compared
    ///         with the hash the pipeline recorded, and stored as code in scan form. Ids are 1-based in
    ///         registration order.
    function registerTarget(string calldata pdbId, string calldata name, uint32 cancerBits, bytes calldata pocket, bytes32 expectedHash)
        external
        onlyOwner
        returns (uint16 id)
    {
        if (bytes(name).length == 0 || bytes(name).length > MAX_NAME) revert BadName();
        if (targetCount == type(uint16).max) revert TooMany();
        bytes32 hash = keccak256(pocket);
        if (hash != expectedHash) revert HashMismatch();
        (uint16 atoms,,,, bytes memory scan) = check.checkPocket(pocket, pdbId);
        address data = DataStore.write(scan);
        id = ++targetCount;
        Target storage t = _targets[id];
        t.pdbId = pdbId;
        t.name = name;
        t.cancerBits = cancerBits;
        t.data = data;
        t.hash = hash;
        t.atoms = atoms;
        nextSettle[id] = currentEpoch();
        emit TargetRegistered(id, pdbId, name, data, hash);
    }

    /// @notice Register a ligand: its topology bytes are checked against SPEC-ENGINE.md section 4.6, hashed,
    ///         compared with the recorded hash, and stored as code.
    function registerLigand(string calldata key, string calldata name, bytes calldata topology, bytes32 expectedHash)
        external
        onlyOwner
        returns (uint16 id)
    {
        if (bytes(key).length == 0 || bytes(key).length > MAX_KEY) revert BadName();
        if (bytes(name).length == 0 || bytes(name).length > MAX_NAME) revert BadName();
        if (ligandCount == type(uint16).max) revert TooMany();
        bytes32 hash = keccak256(topology);
        if (hash != expectedHash) revert HashMismatch();
        (uint8 atoms, uint8 nrot) = check.checkTopology(topology);
        address data = DataStore.write(topology);
        id = ++ligandCount;
        Ligand storage l = _ligands[id];
        l.key = key;
        l.name = name;
        l.data = data;
        l.hash = hash;
        l.atoms = atoms;
        l.nrot = nrot;
        emit LigandRegistered(id, key, name, data, hash);
    }

    /// @notice The price of a docking test in ETH (wei) and in the lab token (smallest unit).
    function setPrices(uint256 runFee_, uint256 runPrice_) external onlyOwner {
        runFee = runFee_;
        runPrice = runPrice_;
        emit PricesSet(runFee_, runPrice_);
    }

    function setPaymentOptions(bool ethAllowed_, bool tokenAllowed_) external onlyOwner {
        ethAllowed = ethAllowed_;
        tokenAllowed = tokenAllowed_;
        emit PaymentOptionsSet(ethAllowed_, tokenAllowed_);
    }

    /// @notice The lab token that pays for docking tests; address(0) leaves only the ETH option.
    function setToken(address token_) external onlyOwner {
        token = token_;
        emit TokenSet(token_);
    }

    function setFeeBps(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeBpsSet(feeBps_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------- internal

    function _target(uint16 id) private view returns (Target storage) {
        if (id == 0 || id > targetCount) revert NoTarget();
        return _targets[id];
    }

    function _ligand(uint16 id) private view returns (Ligand storage) {
        if (id == 0 || id > ligandCount) revert NoLigand();
        return _ligands[id];
    }

    /// @dev strictly lower than the run at `runId` wins; ties keep the earlier run; 0 means no run yet
    function _lower(uint256 runId, int32 score) private view returns (bool) {
        return runId == 0 || score < _runs[runId].scoreMilli;
    }

    /// @dev transferFrom(payer, treasury, amount) with strict checks: the token must have code, the call must
    ///      succeed, and it must return nothing or true. Only one word of return data is copied back.
    function _takeToken(address payer, uint256 amount) private {
        address t = token;
        address to = treasury;
        bool ok;
        uint256 word;
        uint256 size;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, shl(224, 0x23b872dd))
            mstore(add(m, 4), payer)
            mstore(add(m, 36), to)
            mstore(add(m, 68), amount)
            ok := call(gas(), t, 0, m, 100, m, 32)
            size := returndatasize()
            word := mload(m)
        }
        if (!ok || t.code.length == 0) revert TokenPaymentFailed();
        if (size != 0 && (size < 32 || word != 1)) revert TokenPaymentFailed();
    }

    /// @dev Send with a gas allowance and no return data copied. A wallet that refuses is credited instead.
    function _pay(address to, uint256 amount) private {
        bool ok;
        assembly ("memory-safe") {
            ok := call(PAY_GAS, to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            owed[to] += amount;
            totalOwed += amount;
            emit Owed(to, amount);
        }
    }
}
