import {expect} from "chai";
import {ethers, upgrades} from "hardhat";
import {
    VerifierRollupHelperMock,
    ERC20PermitMock,
    FirechainRollupManagerMock,
    FirechainZkEVMGlobalExitRoot,
    FirechainZkEVMBridgeV2,
    FirechainZkEVMV2,
    FirechainRollupBase,
    TokenWrapped,
} from "../../typechain-types";
import {takeSnapshot, time} from "@nomicfoundation/hardhat-network-helpers";
import {processorUtils, contractUtils, MTBridge, mtBridgeUtils} from "@0xpolygonhermez/zkevm-commonjs";
const {calculateSnarkInput, calculateAccInputHash, calculateBatchHashData} = contractUtils;
const MerkleTreeBridge = MTBridge;
const {verifyMerkleProof, getLeafValue} = mtBridgeUtils;

function calculateGlobalExitRoot(mainnetExitRoot: any, rollupExitRoot: any) {
    return ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [mainnetExitRoot, rollupExitRoot]);
}
const _GLOBAL_INDEX_MAINNET_FLAG = 2n ** 64n;

function computeGlobalIndex(indexLocal: any, indexRollup: any, isMainnet: Boolean) {
    if (isMainnet === true) {
        return BigInt(indexLocal) + _GLOBAL_INDEX_MAINNET_FLAG;
    } else {
        return BigInt(indexLocal) + BigInt(indexRollup) * 2n ** 32n;
    }
}

describe("FirechainZkEVMBridge Contract", () => {
    upgrades.silenceWarnings();

    let firechainZkEVMBridgeContract: FirechainZkEVMBridgeV2;
    let polTokenContract: ERC20PermitMock;
    let firechainZkEVMGlobalExitRoot: FirechainZkEVMGlobalExitRoot;

    let deployer: any;
    let rollupManager: any;
    let acc1: any;

    const networkIDMainnet = 0;

    beforeEach("Deploy contracts", async () => {
        // load signers
        [deployer, rollupManager, acc1] = await ethers.getSigners();

        // deploy FirechainZkEVMBridge
        const firechainZkEVMBridgeFactory = await ethers.getContractFactory("FirechainZkEVMBridgeV2");
        firechainZkEVMBridgeContract = (await upgrades.deployProxy(firechainZkEVMBridgeFactory, [], {
            initializer: false,
            unsafeAllow: ["constructor"],
        })) as unknown as FirechainZkEVMBridgeV2;

        // deploy global exit root manager
        const FirechainZkEVMGlobalExitRootFactory = await ethers.getContractFactory("FirechainZkEVMGlobalExitRoot");
        firechainZkEVMGlobalExitRoot = await FirechainZkEVMGlobalExitRootFactory.deploy(
            rollupManager.address,
            firechainZkEVMBridgeContract.target
        );

        await firechainZkEVMBridgeContract.initialize(
            networkIDMainnet,
            ethers.ZeroAddress, // zero for ether
            ethers.ZeroAddress, // zero for ether
            firechainZkEVMGlobalExitRoot.target,
            rollupManager.address,
            "0x"
        );
    });

    it("should claim tokens from Rollup to Mainnet", async () => {
        // create2 parameters
        const mainnetBridgeAddress = "0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe";
        const mainnetMaticAddress = "0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0";
        const mainnetWrappedMaticAddress = "0xa2036f0538221a77A3937F1379699f44945018d0";

        // Matic params
        const tokenName = "Matic Token";
        const tokenSymbol = "MATIC";
        const decimals = 18;
        const metadataToken = ethers.AbiCoder.defaultAbiCoder().encode(
            ["string", "string", "uint8"],
            [tokenName, tokenSymbol, decimals]
        );

        const salt = ethers.solidityPackedKeccak256(["uint32", "address"], [0, mainnetMaticAddress]);

        const minimalBytecodeProxy = await firechainZkEVMBridgeContract.BASE_INIT_BYTECODE_WRAPPED_TOKEN();
        const hashInitCode = ethers.solidityPackedKeccak256(["bytes", "bytes"], [minimalBytecodeProxy, metadataToken]);
        const precalculateWrappedErc20 = await ethers.getCreate2Address(mainnetBridgeAddress, salt, hashInitCode);

        expect(precalculateWrappedErc20).to.be.equal(mainnetWrappedMaticAddress); // mainnet b
    });
});
