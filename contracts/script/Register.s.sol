// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PonchemLab} from "../src/PonchemLab.sol";

/// @notice Registers every target and ligand of the registry on a deployed PonchemLab, in registry order, so that
///         the chain's ids equal the registry's. Resumable: it reads targetCount() and ligandCount() first, checks
///         that every id already on chain carries the registry's hash, and continues from there. Run it through
///         ./register.sh, which sets the environment, prints the plan and records the gas.
///
///   LAB=0x..            the lab (required)
///   REGISTRY=path       the registry file (default ../data/registry.json)
///   REGISTRY_ROOT=path  what the registry's pocket and topology paths are relative to (default ..)
///   START=n             the position in the sequence (targets then ligands) this run must start at; it has to
///                       equal the chain's position or the script refuses, because ids must match
///   LIMIT=n             send at most n registrations in this run (default 0 = all that remain)
///   VERIFY_ONLY=1       check every registered id against the registry and send nothing
///
///         Registry entries: targets[] with pdbId, key, name (or protein, or gene), cancers[] (names, or
///         cancerBits), pocket (path), hash; ligands[] with key, name, topology (path), hash. Names are cut to
///         the lab's 96 bytes.
contract Register is Script {
    string[20] internal CANCERS = [
        "lung", "colorectal", "liver", "breast", "stomach", "pancreatic", "prostate", "esophageal", "cervical",
        "leukemia", "lymphoma", "brain", "melanoma", "ovarian", "bladder", "kidney", "myeloma", "head-and-neck",
        "thyroid", "sarcoma"
    ];

    struct Item {
        bool isTarget;
        string id; // pdbId or key
        string name;
        uint32 cancerBits;
        string path;
        bytes32 hash;
    }

    function run() external {
        PonchemLab lab = PonchemLab(vm.envAddress("LAB"));
        string memory registryPath = vm.envOr("REGISTRY", string("../data/registry.json"));
        string memory root = vm.envOr("REGISTRY_ROOT", string(".."));
        uint256 start = vm.envOr("START", type(uint256).max);
        uint256 limit = vm.envOr("LIMIT", uint256(0));
        bool verifyOnly = vm.envOr("VERIFY_ONLY", false);

        string memory json = vm.readFile(registryPath);
        uint256 nT = _count(json, ".targets");
        uint256 nL = _count(json, ".ligands");
        require(nT > 0 && nL > 0, "the registry has no targets or no ligands");
        console2.log("registry", registryPath);
        console2.log("targets", nT);
        console2.log("ligands", nL);

        uint256 tDone = lab.targetCount();
        uint256 lDone = lab.ligandCount();
        require(tDone <= nT && lDone <= nL, "the lab holds more entries than the registry");
        // what is on chain must be the registry, id for id
        for (uint256 i = 0; i < tDone; i++) {
            (,,,, bytes32 hash,) = lab.target(uint16(i + 1));
            require(hash == vm.parseJsonBytes32(json, _key(".targets", i, "hash")), string.concat("chain and registry disagree at target ", vm.toString(i + 1)));
        }
        for (uint256 i = 0; i < lDone; i++) {
            (,,, bytes32 hash,,) = lab.ligand(uint16(i + 1));
            require(hash == vm.parseJsonBytes32(json, _key(".ligands", i, "hash")), string.concat("chain and registry disagree at ligand ", vm.toString(i + 1)));
        }
        console2.log("already registered: targets", tDone);
        console2.log("already registered: ligands", lDone);

        // targets first, then ligands: the position in that sequence
        uint256 pos = tDone < nT ? tDone : nT + lDone;
        uint256 total = nT + nL;
        if (verifyOnly || pos == total) {
            console2.log("verified ids and hashes", tDone + lDone);
            if (pos == total) console2.log("REGISTRY COMPLETE", total);
            return;
        }
        if (start != type(uint256).max) {
            require(start == pos, string.concat("START must be the chain's position ", vm.toString(pos)));
        }
        uint256 end = limit == 0 ? total : pos + limit;
        if (end > total) end = total;
        console2.log("sending positions", pos, "to", end - 1);

        vm.startBroadcast();
        for (uint256 p = pos; p < end; p++) {
            Item memory it = _item(json, p, nT);
            bytes memory blob = vm.readFileBinary(string.concat(root, "/", it.path));
            require(keccak256(blob) == it.hash, string.concat("file does not match the registry hash: ", it.path));
            uint16 id;
            if (it.isTarget) {
                id = lab.registerTarget(it.id, it.name, it.cancerBits, blob, it.hash);
                require(id == p + 1, "target id off");
            } else {
                id = lab.registerLigand(it.id, it.name, blob, it.hash);
                require(id == p - nT + 1, "ligand id off");
            }
            console2.log(string.concat(it.isTarget ? "target " : "ligand ", vm.toString(uint256(id)), " ", it.id, "  (", vm.toString(p + 1), " of ", vm.toString(total), ", ", vm.toString(blob.length), " bytes)"));
        }
        vm.stopBroadcast();
        if (end == total) console2.log("REGISTRY COMPLETE", total);
        else console2.log("next START", end);
    }

    function _item(string memory json, uint256 p, uint256 nT) internal view returns (Item memory it) {
        if (p < nT) {
            it.isTarget = true;
            it.id = vm.parseJsonString(json, _key(".targets", p, "pdbId"));
            it.name = _name(json, ".targets", p, "protein");
            it.path = vm.parseJsonString(json, _key(".targets", p, "pocket"));
            it.hash = vm.parseJsonBytes32(json, _key(".targets", p, "hash"));
            it.cancerBits = _cancerBits(json, p);
        } else {
            uint256 i = p - nT;
            it.id = vm.parseJsonString(json, _key(".ligands", i, "key"));
            it.name = _name(json, ".ligands", i, "key");
            it.path = vm.parseJsonString(json, _key(".ligands", i, "topology"));
            it.hash = vm.parseJsonBytes32(json, _key(".ligands", i, "hash"));
        }
    }

    function _name(string memory json, string memory list, uint256 i, string memory fallbackField) internal view returns (string memory name) {
        if (vm.keyExistsJson(json, _key(list, i, "name"))) name = vm.parseJsonString(json, _key(list, i, "name"));
        else if (vm.keyExistsJson(json, _key(list, i, fallbackField))) name = vm.parseJsonString(json, _key(list, i, fallbackField));
        else name = vm.parseJsonString(json, _key(list, i, "key"));
        if (bytes(name).length > 96) name = _cut(name, 96);
        if (bytes(name).length == 0) name = vm.parseJsonString(json, _key(list, i, "key"));
    }

    function _cancerBits(string memory json, uint256 i) internal view returns (uint32 bits) {
        if (vm.keyExistsJson(json, _key(".targets", i, "cancerBits"))) {
            return uint32(vm.parseJsonUint(json, _key(".targets", i, "cancerBits")));
        }
        if (!vm.keyExistsJson(json, _key(".targets", i, "cancers"))) return 0;
        string[] memory names = vm.parseJsonStringArray(json, _key(".targets", i, "cancers"));
        for (uint256 k = 0; k < names.length; k++) {
            bytes32 h = keccak256(bytes(names[k]));
            for (uint256 b = 0; b < 20; b++) {
                if (h == keccak256(bytes(CANCERS[b]))) bits |= uint32(1) << uint32(b);
            }
            if (h == keccak256("head and neck")) bits |= uint32(1) << 17;
        }
    }

    function _count(string memory json, string memory list) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(list, "[", vm.toString(n), "]"))) n++;
    }

    function _key(string memory list, uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(list, "[", vm.toString(i), "].", field);
    }

    function _cut(string memory s, uint256 n) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = b[i];
        }
        return string(out);
    }
}
