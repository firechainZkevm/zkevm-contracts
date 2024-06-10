/* eslint-disable no-plusplus, no-await-in-loop */
import {expect} from "chai";
import {ethers, network, upgrades} from "hardhat";
import {
    VerifierRollupHelperMock,
    ERC20PermitMock,
    FirechainRollupManagerMock,
    FirechainZkEVMGlobalExitRootV2,
    FirechainZkEVMBridgeV2,
    FirechainValidiumEtrog,
    FirechainRollupBaseEtrog,
    TokenWrapped,
    Address,
    FirechainRollupManagerEmptyMock__factory,
} from "../../typechain-types";
import {takeSnapshot, time} from "@nomicfoundation/hardhat-network-helpers";
import {processorUtils, contractUtils, MTBridge, mtBridgeUtils} from "@0xpolygonhermez/zkevm-commonjs";
import {array} from "yargs";
import {FirechainDataCommittee} from "../../typechain-types/contracts/v2/consensus/dataComittee";
const {calculateSnarkInput, calculateAccInputHash, calculateBatchHashData} = contractUtils;

type BatchDataStructEtrog = FirechainRollupBaseEtrog.BatchDataStruct;
type ValidiumBatchData = FirechainValidiumEtrog.ValidiumBatchDataStruct;

const MerkleTreeBridge = MTBridge;
const {verifyMerkleProof, getLeafValue} = mtBridgeUtils;

function calculateGlobalExitRoot(mainnetExitRoot: any, rollupExitRoot: any) {
    return ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [mainnetExitRoot, rollupExitRoot]);
}

describe("FirechainZkEVMEtrog", () => {
    let deployer: any;
    let timelock: any;
    let emergencyCouncil: any;
    let trustedAggregator: any;
    let trustedSequencer: any;
    let admin: any;
    let beneficiary: any;

    let verifierContract: VerifierRollupHelperMock;
    let firechainZkEVMBridgeContract: FirechainZkEVMBridgeV2;
    let polTokenContract: ERC20PermitMock;
    let firechainZkEVMGlobalExitRoot: FirechainZkEVMGlobalExitRootV2;
    let rollupManagerContract: FirechainRollupManagerMock;
    let FirechainZKEVMV2Contract: FirechainValidiumEtrog;
    let FirechainDataCommitee: FirechainDataCommittee;

    const polTokenName = "POL Token";
    const polTokenSymbol = "POL";
    const polTokenInitialBalance = ethers.parseEther("20000000");

    const pendingStateTimeoutDefault = 100;
    const trustedAggregatorTimeout = 100;
    const FORCE_BATCH_TIMEOUT = 60 * 60 * 24 * 5; // 5 days
    const _MAX_VERIFY_BATCHES = 1000;
    const _MAX_TRANSACTIONS_BYTE_LENGTH = 120000;
    // BRidge constants
    const networkIDMainnet = 0;
    const networkIDRollup = 1;

    const LEAF_TYPE_ASSET = 0;
    const LEAF_TYPE_MESSAGE = 1;

    const globalExitRootL2Address = "0xa40d5f56745a118d0906a34e69aec8c0db1cb8fa" as unknown as Address;

    let firstDeployment = true;

    const urlSequencer = "http://zkevm-json-rpc:8123";
    const chainID = 1000;
    const networkName = "zkevm";
    const forkID = 0;
    const genesisRandom = "0x0000000000000000000000000000000000000000000000000000000000000001";
    const rollupCompatibilityID = 0;
    const descirption = "zkevm test";
    const networkID = 1;

    // Native token will be ether
    const gasTokenAddress = ethers.ZeroAddress;
    const gasTokenNetwork = 0;

    const SIGNATURE_BYTES = 32 + 32 + 1;
    const EFFECTIVE_PERCENTAGE_BYTES = 1;

    beforeEach("Deploy contract", async () => {
        upgrades.silenceWarnings();

        // load signers
        [deployer, trustedAggregator, trustedSequencer, admin, timelock, emergencyCouncil, beneficiary] =
            await ethers.getSigners();

        // deploy mock verifier
        const VerifierRollupHelperFactory = await ethers.getContractFactory("VerifierRollupHelperMock");
        verifierContract = await VerifierRollupHelperFactory.deploy();

        // deploy pol
        const polTokenFactory = await ethers.getContractFactory("ERC20PermitMock");
        polTokenContract = await polTokenFactory.deploy(
            polTokenName,
            polTokenSymbol,
            deployer.address,
            polTokenInitialBalance
        );

        /*
         * deploy global exit root manager
         * In order to not have trouble with nonce deploy first proxy admin
         */
        await upgrades.deployProxyAdmin();

        if ((await upgrades.admin.getInstance()).target !== "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0") {
            firstDeployment = false;
        }
        const nonceProxyBridge =
            Number(await ethers.provider.getTransactionCount(deployer.address)) + (firstDeployment ? 3 : 2);

        const nonceProxyZkevm = nonceProxyBridge + 1; // Always have to redeploy impl since the firechainZkEVMGlobalExitRoot address changes

        const precalculateBridgeAddress = ethers.getCreateAddress({
            from: deployer.address,
            nonce: nonceProxyBridge,
        });
        const precalculateRollupManagerAddress = ethers.getCreateAddress({
            from: deployer.address,
            nonce: nonceProxyZkevm,
        });
        firstDeployment = false;

        // deploy globalExitRoot
        const FirechainZkEVMGlobalExitRootFactory = await ethers.getContractFactory("FirechainZkEVMGlobalExitRootV2");
        firechainZkEVMGlobalExitRoot = await upgrades.deployProxy(FirechainZkEVMGlobalExitRootFactory, [], {
            initializer: false,
            constructorArgs: [precalculateRollupManagerAddress, precalculateBridgeAddress],
            unsafeAllow: ["constructor", "state-variable-immutable"],
        });

        // deploy FirechainZkEVMBridge
        const firechainZkEVMBridgeFactory = await ethers.getContractFactory("FirechainZkEVMBridgeV2");
        firechainZkEVMBridgeContract = await upgrades.deployProxy(firechainZkEVMBridgeFactory, [], {
            initializer: false,
            unsafeAllow: ["constructor"],
        });

        // deploy mock verifier
        const FirechainRollupManagerFactory = await ethers.getContractFactory("FirechainRollupManagerEmptyMock");

        rollupManagerContract = await FirechainRollupManagerFactory.deploy();

        await rollupManagerContract.waitForDeployment();

        // check precalculated address
        expect(precalculateBridgeAddress).to.be.equal(firechainZkEVMBridgeContract.target);
        expect(precalculateRollupManagerAddress).to.be.equal(rollupManagerContract.target);

        await firechainZkEVMBridgeContract.initialize(
            networkIDMainnet,
            ethers.ZeroAddress, // zero for ether
            ethers.ZeroAddress, // zero for ether
            firechainZkEVMGlobalExitRoot.target,
            rollupManagerContract.target,
            "0x"
        );

        // fund sequencer address with Matic tokens
        await polTokenContract.transfer(trustedSequencer.address, ethers.parseEther("1000"));

        // deploy consensus
        // Create zkEVM implementation
        const FirechainZKEVMV2Factory = await ethers.getContractFactory("FirechainValidiumEtrog");
        FirechainZKEVMV2Contract = await FirechainZKEVMV2Factory.deploy(
            firechainZkEVMGlobalExitRoot.target,
            polTokenContract.target,
            firechainZkEVMBridgeContract.target,
            rollupManagerContract.target
        );
        await FirechainZKEVMV2Contract.waitForDeployment();

        // Create CdkCommitee
        const FirechainDataCommiteeFactory = await ethers.getContractFactory("FirechainDataCommittee");
        FirechainDataCommitee = (await upgrades.deployProxy(FirechainDataCommiteeFactory, [], {
            unsafeAllow: ["constructor"],
        })) as any as FirechainDataCommittee;

        await FirechainDataCommitee.waitForDeployment();
    });

    it("should check the initalized parameters", async () => {
        // initialize zkEVM
        await expect(
            FirechainZKEVMV2Contract.initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                gasTokenAddress,
                urlSequencer,
                networkName
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "OnlyRollupManager");

        // Initialzie using rollup manager
        await ethers.provider.send("hardhat_impersonateAccount", [rollupManagerContract.target]);
        const rolllupManagerSigner = await ethers.getSigner(rollupManagerContract.target as any);
        await expect(
            FirechainZKEVMV2Contract.connect(rolllupManagerSigner).initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                gasTokenAddress,
                urlSequencer,
                networkName,
                {gasPrice: 0}
            )
        ).to.emit(FirechainZKEVMV2Contract, "InitialSequenceBatches");

        expect(await FirechainZKEVMV2Contract.admin()).to.be.equal(admin.address);
        expect(await FirechainZKEVMV2Contract.trustedSequencer()).to.be.equal(trustedSequencer.address);
        expect(await FirechainZKEVMV2Contract.trustedSequencerURL()).to.be.equal(urlSequencer);
        expect(await FirechainZKEVMV2Contract.networkName()).to.be.equal(networkName);
        expect(await FirechainZKEVMV2Contract.forceBatchTimeout()).to.be.equal(FORCE_BATCH_TIMEOUT);

        // initialize zkEVM
        await expect(
            FirechainZKEVMV2Contract.connect(rolllupManagerSigner).initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                gasTokenAddress,
                urlSequencer,
                networkName,
                {gasPrice: 0}
            )
        ).to.be.revertedWith("Initializable: contract is already initialized");
    });

    it("should check the initalized parameters", async () => {
        // initialize zkEVM
        await expect(
            FirechainZKEVMV2Contract.initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                gasTokenAddress,
                urlSequencer,
                networkName
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "OnlyRollupManager");

        // Initialzie using rollup manager
        await ethers.provider.send("hardhat_impersonateAccount", [rollupManagerContract.target]);
        const rolllupManagerSigner = await ethers.getSigner(rollupManagerContract.target as any);
        await expect(
            FirechainZKEVMV2Contract.connect(rolllupManagerSigner).initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                gasTokenAddress,
                urlSequencer,
                networkName,
                {gasPrice: 0}
            )
        ).to.emit(FirechainZKEVMV2Contract, "InitialSequenceBatches");

        expect(await FirechainZKEVMV2Contract.admin()).to.be.equal(admin.address);
        expect(await FirechainZKEVMV2Contract.trustedSequencer()).to.be.equal(trustedSequencer.address);
        expect(await FirechainZKEVMV2Contract.trustedSequencerURL()).to.be.equal(urlSequencer);
        expect(await FirechainZKEVMV2Contract.networkName()).to.be.equal(networkName);
        expect(await FirechainZKEVMV2Contract.forceBatchTimeout()).to.be.equal(FORCE_BATCH_TIMEOUT);

        // initialize zkEVM
        await expect(
            FirechainZKEVMV2Contract.connect(rolllupManagerSigner).initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                gasTokenAddress,
                urlSequencer,
                networkName,
                {gasPrice: 0}
            )
        ).to.be.revertedWith("Initializable: contract is already initialized");
    });

    it("should check admin functions", async () => {
        // Initialzie using rollup manager
        await ethers.provider.send("hardhat_impersonateAccount", [rollupManagerContract.target]);
        const rolllupManagerSigner = await ethers.getSigner(rollupManagerContract.target as any);
        await expect(
            FirechainZKEVMV2Contract.connect(rolllupManagerSigner).initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                gasTokenAddress,
                urlSequencer,
                networkName,
                {gasPrice: 0}
            )
        ).to.emit(FirechainZKEVMV2Contract, "InitialSequenceBatches");

        expect(await FirechainZKEVMV2Contract.isSequenceWithDataAvailabilityAllowed()).to.be.equal(false);

        await expect(FirechainZKEVMV2Contract.switchSequenceWithDataAvailability(true)).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "OnlyAdmin"
        );

        await expect(
            FirechainZKEVMV2Contract.connect(admin).switchSequenceWithDataAvailability(false)
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "SwitchToSameValue");

        await expect(FirechainZKEVMV2Contract.connect(admin).switchSequenceWithDataAvailability(true)).to.emit(
            FirechainZKEVMV2Contract,
            "SwitchSequenceWithDataAvailability"
        );
        expect(await FirechainZKEVMV2Contract.isSequenceWithDataAvailabilityAllowed()).to.be.equal(true);

        expect(await FirechainZKEVMV2Contract.dataAvailabilityProtocol()).to.be.equal(ethers.ZeroAddress);

        await expect(
            FirechainZKEVMV2Contract.setDataAvailabilityProtocol(deployer.address)
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "OnlyAdmin");

        await expect(FirechainZKEVMV2Contract.connect(admin).setDataAvailabilityProtocol(deployer.address))
            .to.emit(FirechainZKEVMV2Contract, "SetDataAvailabilityProtocol")
            .withArgs(deployer.address);

        expect(await FirechainZKEVMV2Contract.dataAvailabilityProtocol()).to.be.equal(deployer.address);

        await expect(FirechainZKEVMV2Contract.connect(admin).setTrustedSequencerURL("0x1253"))
            .to.emit(FirechainZKEVMV2Contract, "SetTrustedSequencerURL")
            .withArgs("0x1253");

        await expect(FirechainZKEVMV2Contract.setTrustedSequencer(deployer.address)).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "OnlyAdmin"
        );
        await expect(FirechainZKEVMV2Contract.setForceBatchTimeout(0)).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "OnlyAdmin"
        );

        await expect(FirechainZKEVMV2Contract.setTrustedSequencer(deployer.address)).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "OnlyAdmin"
        );

        await expect(FirechainZKEVMV2Contract.connect(admin).setTrustedSequencer(deployer.address))
            .to.emit(FirechainZKEVMV2Contract, "SetTrustedSequencer")
            .withArgs(deployer.address);

        await expect(FirechainZKEVMV2Contract.setTrustedSequencerURL("0x1253")).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "OnlyAdmin"
        );
        await expect(FirechainZKEVMV2Contract.connect(admin).setTrustedSequencerURL("0x1253"))
            .to.emit(FirechainZKEVMV2Contract, "SetTrustedSequencerURL")
            .withArgs("0x1253");

        await expect(FirechainZKEVMV2Contract.setForceBatchTimeout(0)).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "OnlyAdmin"
        );

        // Set Forcebatch timeout
        await expect(
            FirechainZKEVMV2Contract.connect(admin).setForceBatchTimeout(FORCE_BATCH_TIMEOUT + 1)
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "InvalidRangeForceBatchTimeout");

        await expect(
            FirechainZKEVMV2Contract.connect(admin).setForceBatchTimeout(FORCE_BATCH_TIMEOUT)
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "InvalidRangeForceBatchTimeout");

        await expect(FirechainZKEVMV2Contract.connect(admin).setForceBatchTimeout(0))
            .to.emit(FirechainZKEVMV2Contract, "SetForceBatchTimeout")
            .withArgs(0);

        expect(await FirechainZKEVMV2Contract.forceBatchTimeout()).to.be.equal(0);

        await rollupManagerContract.activateEmergencyState();
        await expect(FirechainZKEVMV2Contract.connect(admin).setForceBatchTimeout(FORCE_BATCH_TIMEOUT))
            .to.emit(FirechainZKEVMV2Contract, "SetForceBatchTimeout")
            .withArgs(FORCE_BATCH_TIMEOUT);
        await rollupManagerContract.deactivateEmergencyState();

        await expect(FirechainZKEVMV2Contract.transferAdminRole(deployer.address)).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "OnlyAdmin"
        );

        await expect(FirechainZKEVMV2Contract.connect(admin).transferAdminRole(deployer.address))
            .to.emit(FirechainZKEVMV2Contract, "TransferAdminRole")
            .withArgs(deployer.address);

        await expect(FirechainZKEVMV2Contract.connect(admin).acceptAdminRole()).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "OnlyPendingAdmin"
        );

        await expect(FirechainZKEVMV2Contract.connect(deployer).acceptAdminRole())
            .to.emit(FirechainZKEVMV2Contract, "AcceptAdminRole")
            .withArgs(deployer.address);

        // Check force batches are unactive
        await expect(FirechainZKEVMV2Contract.forceBatch("0x", 0)).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "ForceBatchNotAllowed"
        );
        await expect(FirechainZKEVMV2Contract.sequenceForceBatches([])).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "ForceBatchNotAllowed"
        );

        // deployer now is the admin
        await expect(
            FirechainZKEVMV2Contract.connect(admin).setForceBatchAddress(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "OnlyAdmin");

        await expect(FirechainZKEVMV2Contract.connect(deployer).setForceBatchAddress(ethers.ZeroAddress))
            .to.emit(FirechainZKEVMV2Contract, "SetForceBatchAddress")
            .withArgs(ethers.ZeroAddress);

        await expect(
            FirechainZKEVMV2Contract.connect(deployer).setForceBatchAddress(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "ForceBatchesDecentralized");

        // Check revert onVerifyBatches
        await expect(
            FirechainZKEVMV2Contract.connect(admin).onVerifyBatches(0, ethers.ZeroHash, trustedAggregator.address)
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "OnlyRollupManager");
    });

    it("should check admin functions data commitee", async () => {
        expect(await FirechainDataCommitee.requiredAmountOfSignatures()).to.be.equal(0);
        expect(await FirechainDataCommitee.committeeHash()).to.be.equal(ethers.ZeroHash);
        expect(await FirechainDataCommitee.getAmountOfMembers()).to.be.equal(0);
        expect(await FirechainDataCommitee.getProcotolName()).to.be.equal("DataAvailabilityCommittee");

        const requiredAmountOfSignatures = 3;
        const urls = ["onurl", "twourl", "threeurl"];
        const walletsDataCommitee = [] as any;
        let addrBytes = "0x";

        for (let i = 0; i < 3; i++) {
            const newWallet = ethers.HDNodeWallet.fromMnemonic(
                ethers.Mnemonic.fromPhrase("test test test test test test test test test test test junk"),
                `m/44'/60'/0'/0/${i}`
            );
            walletsDataCommitee.push(newWallet);
            addrBytes = addrBytes + newWallet.address.slice(2);
        }

        await expect(
            FirechainDataCommitee.connect(admin).setupCommittee(requiredAmountOfSignatures, urls, addrBytes)
        ).to.be.revertedWith("Ownable: caller is not the owner");

        await expect(
            FirechainDataCommitee.setupCommittee(requiredAmountOfSignatures, urls.slice(1), addrBytes)
        ).to.be.revertedWithCustomError(FirechainDataCommitee, "TooManyRequiredSignatures");

        await expect(
            FirechainDataCommitee.setupCommittee(requiredAmountOfSignatures, urls, "0x" + addrBytes.slice(4))
        ).to.be.revertedWithCustomError(FirechainDataCommitee, "UnexpectedAddrsBytesLength");

        await expect(FirechainDataCommitee.setupCommittee(1, [""], deployer.address)).to.be.revertedWithCustomError(
            FirechainDataCommitee,
            "EmptyURLNotAllowed"
        );

        await expect(
            FirechainDataCommitee.setupCommittee(requiredAmountOfSignatures, urls, addrBytes)
        ).to.be.revertedWithCustomError(FirechainDataCommitee, "WrongAddrOrder");

        // sort wallets
        walletsDataCommitee.sort((walleta: any, walletb: any) => {
            if (ethers.toBigInt(walleta.address) > ethers.toBigInt(walletb.address)) {
                return 1;
            } else {
                return -1;
            }
        });
        addrBytes = "0x";

        for (let i = 0; i < walletsDataCommitee.length; i++) {
            addrBytes = addrBytes + walletsDataCommitee[i].address.slice(2);
        }

        const commiteeHash = ethers.keccak256(addrBytes);

        await expect(FirechainDataCommitee.setupCommittee(requiredAmountOfSignatures, urls, addrBytes))
            .to.emit(FirechainDataCommitee, "CommitteeUpdated")
            .withArgs(commiteeHash);

        expect(await FirechainDataCommitee.requiredAmountOfSignatures()).to.be.equal(3);
        expect(await FirechainDataCommitee.committeeHash()).to.be.equal(commiteeHash);
        expect(await FirechainDataCommitee.getAmountOfMembers()).to.be.equal(3);
    });

    it("should generateInitializeTransaction with huge metadata", async () => {
        const hugeMetadata = `0x${"00".repeat(Number(2n ** 16n))}`;
        await expect(
            FirechainZKEVMV2Contract.generateInitializeTransaction(0, ethers.ZeroAddress, 1, hugeMetadata)
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "HugeTokenMetadataNotSupported");
    });
    it("should check full flow", async () => {
        // Initialzie using rollup manager
        await ethers.provider.send("hardhat_impersonateAccount", [rollupManagerContract.target]);
        const rolllupManagerSigner = await ethers.getSigner(rollupManagerContract.target as any);
        await expect(
            FirechainZKEVMV2Contract.connect(rolllupManagerSigner).initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                gasTokenAddress,
                urlSequencer,
                networkName,
                {gasPrice: 0}
            )
        ).to.emit(FirechainZKEVMV2Contract, "InitialSequenceBatches");
        const blockCreatedRollup = await ethers.provider.getBlock("latest");
        const timestampCreatedRollup = blockCreatedRollup?.timestamp;

        const transaction = await FirechainZKEVMV2Contract.generateInitializeTransaction(
            networkID,
            gasTokenAddress,
            gasTokenNetwork,
            "0x" // empty metadata
        );

        // Check transaction
        const bridgeL2Factory = await ethers.getContractFactory("FirechainZkEVMBridgeV2");
        const encodedData = bridgeL2Factory.interface.encodeFunctionData("initialize", [
            networkID,
            gasTokenAddress,
            gasTokenNetwork,
            globalExitRootL2Address,
            ethers.ZeroAddress,
            "0x", // empty metadata
        ]);

        const rawTx = processorUtils.customRawTxToRawTx(transaction);
        const tx = ethers.Transaction.from(rawTx);

        const rlpSignData = transaction.slice(0, -(SIGNATURE_BYTES * 2 + EFFECTIVE_PERCENTAGE_BYTES * 2));
        expect(rlpSignData).to.be.equal(tx.unsignedSerialized);

        expect(tx.to).to.be.equal(firechainZkEVMBridgeContract.target);
        expect(tx.value).to.be.equal(0);
        expect(tx.data).to.be.equal(encodedData);
        expect(tx.gasPrice).to.be.equal(0);
        expect(tx.gasLimit).to.be.equal(30000000);
        expect(tx.nonce).to.be.equal(0);
        expect(tx.chainId).to.be.equal(0);

        const expectedAccInputHash = calculateAccInputHashetrog(
            ethers.ZeroHash,
            ethers.keccak256(transaction),
            await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot(),
            timestampCreatedRollup,
            trustedSequencer.address,
            blockCreatedRollup?.parentHash
        );

        // calcualte accINputHash
        expect(await FirechainZKEVMV2Contract.lastAccInputHash()).to.be.equal(expectedAccInputHash);

        // try verify batches
        const l2txData = "0x123456";
        const maticAmount = await rollupManagerContract.getBatchFee();

        const sequence = {
            transactions: l2txData,
            forcedGlobalExitRoot: ethers.ZeroHash,
            forcedTimestamp: 0,
            forcedBlockHashL1: ethers.ZeroHash,
        } as BatchDataStructEtrog;

        // Approve tokens
        await expect(
            polTokenContract.connect(trustedSequencer).approve(FirechainZKEVMV2Contract.target, maticAmount)
        ).to.emit(polTokenContract, "Approval");

        // Sequence Batches
        const currentLastBatchSequenced = 1;

        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatches(
                [sequence],
                0,
                currentLastBatchSequenced,
                trustedSequencer.address
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "SequenceWithDataAvailabilityNotAllowed");

        await expect(FirechainZKEVMV2Contract.connect(admin).switchSequenceWithDataAvailability(true)).to.emit(
            FirechainZKEVMV2Contract,
            "SwitchSequenceWithDataAvailability"
        );

        const currentTime = Number((await ethers.provider.getBlock("latest"))?.timestamp);

        await ethers.provider.send("evm_setNextBlockTimestamp", [currentTime + 1]);

        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatches(
                [sequence],
                currentTime + 38,
                currentLastBatchSequenced,
                trustedSequencer.address
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "MaxTimestampSequenceInvalid");

        await expect(
            FirechainZKEVMV2Contract.sequenceBatches(
                [sequence],
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "OnlyTrustedSequencer");

        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatches(
                [],
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "SequenceZeroBatches");

        const hugeBatchArray = new Array(_MAX_VERIFY_BATCHES + 1).fill({
            transactions: "0x",
            forcedGlobalExitRoot: ethers.ZeroHash,
            forcedTimestamp: 0,
            forcedBlockHashL1: ethers.ZeroHash,
        });

        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatches(
                hugeBatchArray,
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "ExceedMaxVerifyBatches");

        // Create a huge sequence
        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatches(
                [
                    {
                        transactions: `0x${"00".repeat(_MAX_TRANSACTIONS_BYTE_LENGTH + 1)}` as any,
                        forcedGlobalExitRoot: ethers.ZeroHash,
                        forcedTimestamp: 0,
                        forcedBlockHashL1: ethers.ZeroHash,
                    },
                ],
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "TransactionsLengthAboveMax");

        // False forced batch
        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatches(
                [
                    {
                        transactions: "0x",
                        forcedGlobalExitRoot: ethers.hexlify(ethers.randomBytes(32)),
                        forcedTimestamp: 1000,
                        forcedBlockHashL1: ethers.ZeroHash,
                    },
                ],
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "ForcedDataDoesNotMatch");

        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatches(
                [sequence],
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address
            )
        ).to.emit(FirechainZKEVMV2Contract, "SequenceBatches");

        const currentTimestampSequenced = (await ethers.provider.getBlock("latest"))?.timestamp;

        const expectedAccInputHash2 = calculateAccInputHashetrog(
            expectedAccInputHash,
            ethers.keccak256(l2txData),
            await firechainZkEVMGlobalExitRoot.getRoot(),
            currentTime,
            trustedSequencer.address,
            ethers.ZeroHash
        );

        // calcualte accINputHash
        expect(await FirechainZKEVMV2Contract.lastAccInputHash()).to.be.equal(expectedAccInputHash2);
    });

    it("should check full flow with data commitee", async () => {
        // Initialzie using rollup manager
        await ethers.provider.send("hardhat_impersonateAccount", [rollupManagerContract.target]);
        const rolllupManagerSigner = await ethers.getSigner(rollupManagerContract.target as any);
        await expect(
            FirechainZKEVMV2Contract.connect(rolllupManagerSigner).initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                gasTokenAddress,
                urlSequencer,
                networkName,
                {gasPrice: 0}
            )
        ).to.emit(FirechainZKEVMV2Contract, "InitialSequenceBatches");
        const blockCreatedRollup = await ethers.provider.getBlock("latest");
        const timestampCreatedRollup = blockCreatedRollup?.timestamp;

        await expect(FirechainZKEVMV2Contract.connect(admin).switchSequenceWithDataAvailability(true)).to.emit(
            FirechainZKEVMV2Contract,
            "SwitchSequenceWithDataAvailability"
        );

        const transaction = await FirechainZKEVMV2Contract.generateInitializeTransaction(
            networkID,
            gasTokenAddress,
            gasTokenNetwork,
            "0x" // empty metadata
        );

        // Check transaction
        const bridgeL2Factory = await ethers.getContractFactory("FirechainZkEVMBridgeV2");
        const encodedData = bridgeL2Factory.interface.encodeFunctionData("initialize", [
            networkID,
            gasTokenAddress,
            gasTokenNetwork,
            globalExitRootL2Address,
            ethers.ZeroAddress,
            "0x", // empty metadata
        ]);

        const rawTx = processorUtils.customRawTxToRawTx(transaction);
        const tx = ethers.Transaction.from(rawTx);

        const rlpSignData = transaction.slice(0, -(SIGNATURE_BYTES * 2 + EFFECTIVE_PERCENTAGE_BYTES * 2));
        expect(rlpSignData).to.be.equal(tx.unsignedSerialized);

        expect(tx.to).to.be.equal(firechainZkEVMBridgeContract.target);
        expect(tx.value).to.be.equal(0);
        expect(tx.data).to.be.equal(encodedData);
        expect(tx.gasPrice).to.be.equal(0);
        expect(tx.gasLimit).to.be.equal(30000000);
        expect(tx.nonce).to.be.equal(0);
        expect(tx.chainId).to.be.equal(0);

        const expectedAccInputHash = calculateAccInputHashetrog(
            ethers.ZeroHash,
            ethers.keccak256(transaction),
            await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot(),
            timestampCreatedRollup,
            trustedSequencer.address,
            blockCreatedRollup?.parentHash
        );

        // calcualte accINputHash
        expect(await FirechainZKEVMV2Contract.lastAccInputHash()).to.be.equal(expectedAccInputHash);

        // try verify batches
        const l2txData = "0x123456";
        const hashedData = ethers.keccak256(l2txData) as any;
        const maticAmount = await rollupManagerContract.getBatchFee();

        const sequenceValidium = {
            transactionsHash: hashedData,
            forcedGlobalExitRoot: ethers.ZeroHash,
            forcedTimestamp: 0,
            forcedBlockHashL1: ethers.ZeroHash,
        } as ValidiumBatchData;

        // Approve tokens
        await expect(
            polTokenContract.connect(trustedSequencer).approve(FirechainZKEVMV2Contract.target, maticAmount)
        ).to.emit(polTokenContract, "Approval");

        // Sequence Batches
        const currentTime = Number((await ethers.provider.getBlock("latest"))?.timestamp);
        let currentLastBatchSequenced = 1;
        await expect(
            FirechainZKEVMV2Contract.sequenceBatchesValidium(
                [sequenceValidium],
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address,
                "0x1233"
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "OnlyTrustedSequencer");

        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatchesValidium(
                [],
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address,
                "0x1233"
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "SequenceZeroBatches");

        const hugeBatchArray = new Array(_MAX_VERIFY_BATCHES + 1).fill({
            transactionsHash: hashedData,
            forcedGlobalExitRoot: ethers.ZeroHash,
            forcedTimestamp: 0,
            forcedBlockHashL1: ethers.ZeroHash,
        });

        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatchesValidium(
                hugeBatchArray,
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address,
                "0x"
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "ExceedMaxVerifyBatches");

        // False forced batch
        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatchesValidium(
                [
                    {
                        transactionsHash: hashedData,
                        forcedGlobalExitRoot: ethers.hexlify(ethers.randomBytes(32)),
                        forcedTimestamp: 1000,
                        forcedBlockHashL1: ethers.ZeroHash,
                    },
                ],
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address,
                "0x"
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "ForcedDataDoesNotMatch");

        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatchesValidium(
                [sequenceValidium],
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address,
                "0x1233"
            )
        ).to.be.reverted;

        // Setup commitee
        await FirechainZKEVMV2Contract.connect(admin).setDataAvailabilityProtocol(FirechainDataCommitee.target);

        const requiredAmountOfSignatures = 3;
        const urls = ["onurl", "twourl", "threeurl"];
        const walletsDataCommitee = [] as any;
        let unsortedAddrBytes = "0x";

        for (let i = 0; i < 3; i++) {
            const newWallet = ethers.HDNodeWallet.fromMnemonic(
                ethers.Mnemonic.fromPhrase("test test test test test test test test test test test junk"),
                `m/44'/60'/0'/0/${i}`
            );
            walletsDataCommitee.push(newWallet);
            unsortedAddrBytes = unsortedAddrBytes + newWallet.address.slice(2);
        }
        // sort wallets
        walletsDataCommitee.sort((walleta: any, walletb: any) => {
            if (ethers.toBigInt(walleta.address) > ethers.toBigInt(walletb.address)) {
                return 1;
            } else {
                return -1;
            }
        });

        let addrBytes = "0x";
        for (let i = 0; i < walletsDataCommitee.length; i++) {
            addrBytes = addrBytes + walletsDataCommitee[i].address.slice(2);
        }

        const commiteeHash = ethers.keccak256(addrBytes);
        const signedData = ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [ethers.ZeroHash, hashedData]);
        let message = "0x";
        for (let i = 0; i < walletsDataCommitee.length; i++) {
            const newSignature = walletsDataCommitee[i].signingKey.sign(signedData);
            message = message + newSignature.serialized.slice(2);
        }
        await expect(FirechainDataCommitee.setupCommittee(requiredAmountOfSignatures, urls, addrBytes))
            .to.emit(FirechainDataCommitee, "CommitteeUpdated")
            .withArgs(commiteeHash);

        let dataAvailabilityMessage = message + addrBytes.slice(2);
        const badDataAvMessage = message + unsortedAddrBytes.slice(2);
        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatchesValidium(
                [sequenceValidium],
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address,
                badDataAvMessage
            )
        ).to.be.revertedWithCustomError(FirechainDataCommitee, "UnexpectedCommitteeHash");

        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatchesValidium(
                [sequenceValidium],
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address,
                badDataAvMessage.slice(0, -2)
            )
        ).to.be.revertedWithCustomError(FirechainDataCommitee, "UnexpectedAddrsAndSignaturesSize");

        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatchesValidium(
                [sequenceValidium],
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address,
                dataAvailabilityMessage
            )
        ).to.emit(FirechainZKEVMV2Contract, "SequenceBatches");

        const expectedAccInputHash2 = calculateAccInputHashetrog(
            expectedAccInputHash,
            hashedData,
            await firechainZkEVMGlobalExitRoot.getRoot(),
            currentTime,
            trustedSequencer.address,
            ethers.ZeroHash
        );

        // calcualte accINputHash
        expect(await FirechainZKEVMV2Contract.lastAccInputHash()).to.be.equal(expectedAccInputHash2);
    });

    it("should check full flow with wrapped gas token", async () => {
        // Create a new wrapped token mocking the bridge
        const tokenName = "Matic Token L2";
        const tokenSymbol = "MATIC";
        const decimals = 18;
        const metadataToken = ethers.AbiCoder.defaultAbiCoder().encode(
            ["string", "string", "uint8"],
            [tokenName, tokenSymbol, decimals]
        );

        const originNetwork = networkIDRollup;
        const tokenAddress = ethers.getAddress(ethers.hexlify(ethers.randomBytes(20)));
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDMainnet;
        const destinationAddress = beneficiary.address;
        const metadata = metadataToken; // since we are inserting in the exit root can be anything
        const metadataHash = ethers.solidityPackedKeccak256(["bytes"], [metadata]);

        // compute root merkle tree in Js
        const height = 32;
        const merkleTreezkEVM = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash
        );

        // Add 2 leafs
        merkleTreezkEVM.add(leafValue);
        merkleTreezkEVM.add(leafValue);

        // check merkle root with SC
        const rootzkEVM = merkleTreezkEVM.getRoot();

        // Calcualte new globalExitroot
        const merkleTreeRollups = new MerkleTreeBridge(height);
        merkleTreeRollups.add(rootzkEVM);
        const rootRollups = merkleTreeRollups.getRoot();

        // Assert global exit root
        await ethers.provider.send("hardhat_impersonateAccount", [rollupManagerContract.target]);
        const rolllupManagerSigner = await ethers.getSigner(rollupManagerContract.target as any);
        await firechainZkEVMGlobalExitRoot.connect(rolllupManagerSigner).updateExitRoot(rootRollups, {gasPrice: 0});

        expect(await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot()).to.be.equal(ethers.ZeroHash);
        expect(await firechainZkEVMGlobalExitRoot.lastRollupExitRoot()).to.be.equal(rootRollups);

        expect(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot()).to.be.equal(
            calculateGlobalExitRoot(ethers.ZeroHash, rootRollups)
        );

        const indexLeaf = 0;
        const proofZkEVM = merkleTreezkEVM.getProofTreeByIndex(indexLeaf);
        const proofRollups = merkleTreeRollups.getProofTreeByIndex(indexLeaf);

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proofZkEVM, indexLeaf, rootzkEVM)).to.be.equal(true);
        expect(verifyMerkleProof(rootzkEVM, proofRollups, indexLeaf, rootRollups)).to.be.equal(true);

        expect(
            await firechainZkEVMBridgeContract.verifyMerkleProof(leafValue, proofZkEVM, indexLeaf, rootzkEVM)
        ).to.be.equal(true);

        expect(
            await firechainZkEVMBridgeContract.verifyMerkleProof(rootzkEVM, proofRollups, indexLeaf, rootRollups)
        ).to.be.equal(true);

        // claim
        const tokenWrappedFactory = await ethers.getContractFactory("TokenWrapped");
        // create2 parameters
        const salt = ethers.solidityPackedKeccak256(["uint32", "address"], [networkIDRollup, tokenAddress]);
        const minimalBytecodeProxy = await firechainZkEVMBridgeContract.BASE_INIT_BYTECODE_WRAPPED_TOKEN();
        const hashInitCode = ethers.solidityPackedKeccak256(["bytes", "bytes"], [minimalBytecodeProxy, metadataToken]);
        const precalculateWrappedErc20 = await ethers.getCreate2Address(
            firechainZkEVMBridgeContract.target as string,
            salt,
            hashInitCode
        );
        const newWrappedToken = tokenWrappedFactory.attach(precalculateWrappedErc20) as TokenWrapped;

        // Use precalculatedWrapperAddress and check if matches
        expect(
            await firechainZkEVMBridgeContract.precalculatedWrapperAddress(
                networkIDRollup,
                tokenAddress,
                tokenName,
                tokenSymbol,
                decimals
            )
        ).to.be.equal(precalculateWrappedErc20);

        // index leaf is 0 bc, does not have mainnet flag, and it's rollup 0 on leaf 0
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofZkEVM,
                proofRollups,
                indexLeaf,
                ethers.ZeroHash,
                rootRollups,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "ClaimEvent")
            .withArgs(indexLeaf, originNetwork, tokenAddress, destinationAddress, amount)
            .to.emit(firechainZkEVMBridgeContract, "NewWrappedToken")
            .withArgs(originNetwork, tokenAddress, precalculateWrappedErc20, metadata)
            .to.emit(newWrappedToken, "Transfer")
            .withArgs(ethers.ZeroAddress, beneficiary.address, amount);

        // Assert maps created
        const newTokenInfo = await firechainZkEVMBridgeContract.wrappedTokenToTokenInfo(precalculateWrappedErc20);

        expect(newTokenInfo.originNetwork).to.be.equal(networkIDRollup);
        expect(newTokenInfo.originTokenAddress).to.be.equal(tokenAddress);
        expect(await firechainZkEVMBridgeContract.getTokenWrappedAddress(networkIDRollup, tokenAddress)).to.be.equal(
            precalculateWrappedErc20
        );
        expect(await firechainZkEVMBridgeContract.getTokenWrappedAddress(networkIDRollup, tokenAddress)).to.be.equal(
            precalculateWrappedErc20
        );

        expect(await firechainZkEVMBridgeContract.tokenInfoToWrappedToken(salt)).to.be.equal(precalculateWrappedErc20);

        // Check the wrapper info
        expect(await newWrappedToken.name()).to.be.equal(tokenName);
        expect(await newWrappedToken.symbol()).to.be.equal(tokenSymbol);
        expect(await newWrappedToken.decimals()).to.be.equal(decimals);

        // Initialzie using rollup manager with gas token
        await ethers.provider.send("hardhat_impersonateAccount", [rollupManagerContract.target]);
        await expect(
            FirechainZKEVMV2Contract.connect(rolllupManagerSigner).initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                newWrappedToken.target,
                urlSequencer,
                networkName,
                {gasPrice: 0}
            )
        ).to.emit(FirechainZKEVMV2Contract, "InitialSequenceBatches");

        const timestampCreatedRollup = (await ethers.provider.getBlock("latest"))?.timestamp;

        const transaction = await FirechainZKEVMV2Contract.generateInitializeTransaction(
            networkID,
            tokenAddress,
            originNetwork,
            metadata // empty metadata
        );

        // Check transaction
        const bridgeL2Factory = await ethers.getContractFactory("FirechainZkEVMBridgeV2");
        const encodedData = bridgeL2Factory.interface.encodeFunctionData("initialize", [
            networkID,
            tokenAddress,
            originNetwork,
            globalExitRootL2Address,
            ethers.ZeroAddress,
            metadata, // empty metadata
        ]);

        const blockCreatedRollup = await ethers.provider.getBlock("latest");

        const rawTx = processorUtils.customRawTxToRawTx(transaction);
        const tx = ethers.Transaction.from(rawTx);

        const rlpSignData = transaction.slice(0, -(SIGNATURE_BYTES * 2 + EFFECTIVE_PERCENTAGE_BYTES * 2));
        expect(rlpSignData).to.be.equal(tx.unsignedSerialized);

        expect(tx.to).to.be.equal(firechainZkEVMBridgeContract.target);
        expect(tx.value).to.be.equal(0);
        expect(tx.data).to.be.equal(encodedData);
        expect(tx.gasPrice).to.be.equal(0);
        expect(tx.gasLimit).to.be.equal(30000000);
        expect(tx.nonce).to.be.equal(0);
        expect(tx.chainId).to.be.equal(0);

        const expectedAccInputHash = calculateAccInputHashetrog(
            ethers.ZeroHash,
            ethers.keccak256(transaction),
            await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot(),
            timestampCreatedRollup,
            trustedSequencer.address,
            blockCreatedRollup?.parentHash
        );

        // calcualte accINputHash
        expect(await FirechainZKEVMV2Contract.lastAccInputHash()).to.be.equal(expectedAccInputHash);

        expect(await FirechainZKEVMV2Contract.gasTokenAddress()).to.be.equal(tokenAddress);
        expect(await FirechainZKEVMV2Contract.gasTokenNetwork()).to.be.equal(originNetwork);
    });

    it("should check forced batches and sequenced withou data commitee", async () => {
        // Initialzie using rollup manager
        await ethers.provider.send("hardhat_impersonateAccount", [rollupManagerContract.target]);
        const rolllupManagerSigner = await ethers.getSigner(rollupManagerContract.target as any);
        await expect(
            FirechainZKEVMV2Contract.connect(rolllupManagerSigner).initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                gasTokenAddress,
                urlSequencer,
                networkName,
                {gasPrice: 0}
            )
        ).to.emit(FirechainZKEVMV2Contract, "InitialSequenceBatches");

        const timestampCreatedRollup = (await ethers.provider.getBlock("latest"))?.timestamp;
        const transaction = await FirechainZKEVMV2Contract.generateInitializeTransaction(
            networkID,
            gasTokenAddress,
            gasTokenNetwork,
            "0x" // empty metadata
        );

        // Check transaction
        const bridgeL2Factory = await ethers.getContractFactory("FirechainZkEVMBridgeV2");
        const encodedData = bridgeL2Factory.interface.encodeFunctionData("initialize", [
            networkID,
            gasTokenAddress,
            gasTokenNetwork,
            globalExitRootL2Address,
            ethers.ZeroAddress,
            "0x", // empty metadata
        ]);

        const blockCreatedRollup = await ethers.provider.getBlock("latest");

        const rawTx = processorUtils.customRawTxToRawTx(transaction);
        const tx = ethers.Transaction.from(rawTx);

        const rlpSignData = transaction.slice(0, -(SIGNATURE_BYTES * 2 + EFFECTIVE_PERCENTAGE_BYTES * 2));
        expect(rlpSignData).to.be.equal(tx.unsignedSerialized);

        expect(tx.to).to.be.equal(firechainZkEVMBridgeContract.target);
        expect(tx.value).to.be.equal(0);
        expect(tx.data).to.be.equal(encodedData);
        expect(tx.gasPrice).to.be.equal(0);
        expect(tx.gasLimit).to.be.equal(30000000);
        expect(tx.nonce).to.be.equal(0);
        expect(tx.chainId).to.be.equal(0);

        const expectedAccInputHash = calculateAccInputHashetrog(
            ethers.ZeroHash,
            ethers.keccak256(transaction),
            await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot(),
            timestampCreatedRollup,
            trustedSequencer.address,
            blockCreatedRollup?.parentHash
        );

        // calcualte accINputHash
        expect(await FirechainZKEVMV2Contract.lastAccInputHash()).to.be.equal(expectedAccInputHash);

        // try verify batches
        const l2txData = "0x123456";
        const maticAmount = ethers.parseEther("1");

        // Approve tokens
        await expect(polTokenContract.connect(admin).approve(FirechainZKEVMV2Contract.target, maticAmount)).to.emit(
            polTokenContract,
            "Approval"
        );

        expect(await FirechainZKEVMV2Contract.calculatePolPerForceBatch()).to.be.equal(0);

        const globalExitRoot = await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        // force Batches
        await expect(FirechainZKEVMV2Contract.forceBatch(l2txData, maticAmount)).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "ForceBatchNotAllowed"
        );

        //await FirechainZKEVMV2Contract.connect(admin).activateForceBatches();
        await polTokenContract.transfer(admin.address, ethers.parseEther("1000"));

        // force Batches
        await expect(FirechainZKEVMV2Contract.forceBatch(l2txData, 0)).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "ForceBatchNotAllowed"
        );

        await expect(FirechainZKEVMV2Contract.connect(admin).forceBatch(l2txData, 0)).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "NotEnoughPOLAmount"
        );

        await expect(
            FirechainZKEVMV2Contract.connect(admin).forceBatch(
                `0x${"00".repeat(_MAX_TRANSACTIONS_BYTE_LENGTH + 1)}`,
                maticAmount
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "TransactionsLengthAboveMax");

        await expect(FirechainZKEVMV2Contract.connect(admin).forceBatch(l2txData, maticAmount))
            .to.emit(FirechainZKEVMV2Contract, "ForceBatch")
            .withArgs(1, globalExitRoot, admin.address, "0x");

        const blockForced = await ethers.provider.getBlock("latest");
        const timestampForceBatch = blockForced?.timestamp as any;

        // Sequence force batches
        const sequenceForced = {
            transactionsHash: ethers.keccak256(l2txData),
            forcedGlobalExitRoot: globalExitRoot,
            forcedTimestamp: timestampForceBatch,
            forcedBlockHashL1: blockForced?.parentHash,
        } as ValidiumBatchData;

        // Even if a data commitee is not set it will work since it's not checked
        await FirechainZKEVMV2Contract.connect(admin).setDataAvailabilityProtocol(FirechainDataCommitee.target);

        const requiredAmountOfSignatures = 3;
        const urls = ["onurl", "twourl", "threeurl"];
        const walletsDataCommitee = [] as any;
        let unsortedAddrBytes = "0x";

        for (let i = 0; i < 3; i++) {
            const newWallet = ethers.HDNodeWallet.fromMnemonic(
                ethers.Mnemonic.fromPhrase("test test test test test test test test test test test junk"),
                `m/44'/60'/0'/0/${i}`
            );
            walletsDataCommitee.push(newWallet);
            unsortedAddrBytes = unsortedAddrBytes + newWallet.address.slice(2);
        }
        // sort wallets
        walletsDataCommitee.sort((walleta: any, walletb: any) => {
            if (ethers.toBigInt(walleta.address) > ethers.toBigInt(walletb.address)) {
                return 1;
            } else {
                return -1;
            }
        });

        let addrBytes = "0x";
        for (let i = 0; i < walletsDataCommitee.length; i++) {
            addrBytes = addrBytes + walletsDataCommitee[i].address.slice(2);
        }

        const commiteeHash = ethers.keccak256(addrBytes);
        const signedData = ethers.solidityPackedKeccak256(
            ["bytes32", "bytes32"],
            [ethers.ZeroHash, ethers.keccak256(l2txData)]
        );
        let message = "0x";
        for (let i = 0; i < walletsDataCommitee.length; i++) {
            const newSignature = walletsDataCommitee[i].signingKey.sign(signedData);
            message = message + newSignature.serialized.slice(2);
        }
        await expect(FirechainDataCommitee.setupCommittee(requiredAmountOfSignatures, urls, addrBytes))
            .to.emit(FirechainDataCommitee, "CommitteeUpdated")
            .withArgs(commiteeHash);

        const currentTime = Number((await ethers.provider.getBlock("latest"))?.timestamp);
        const currentLastBatchSequenced = 1;
        await expect(
            FirechainZKEVMV2Contract.connect(trustedSequencer).sequenceBatchesValidium(
                [sequenceForced],
                currentTime,
                currentLastBatchSequenced,
                trustedSequencer.address,
                "0x12"
            )
        ).to.emit(FirechainZKEVMV2Contract, "SequenceBatches");
    });

    it("should check forced batches", async () => {
        // Initialzie using rollup manager
        await ethers.provider.send("hardhat_impersonateAccount", [rollupManagerContract.target]);
        const rolllupManagerSigner = await ethers.getSigner(rollupManagerContract.target as any);
        await expect(
            FirechainZKEVMV2Contract.connect(rolllupManagerSigner).initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                gasTokenAddress,
                urlSequencer,
                networkName,
                {gasPrice: 0}
            )
        ).to.emit(FirechainZKEVMV2Contract, "InitialSequenceBatches");

        const timestampCreatedRollup = (await ethers.provider.getBlock("latest"))?.timestamp;
        const transaction = await FirechainZKEVMV2Contract.generateInitializeTransaction(
            networkID,
            gasTokenAddress,
            gasTokenNetwork,
            "0x" // empty metadata
        );

        // Check transaction
        const bridgeL2Factory = await ethers.getContractFactory("FirechainZkEVMBridgeV2");
        const encodedData = bridgeL2Factory.interface.encodeFunctionData("initialize", [
            networkID,
            gasTokenAddress,
            gasTokenNetwork,
            globalExitRootL2Address,
            ethers.ZeroAddress,
            "0x", // empty metadata
        ]);

        const blockCreatedRollup = await ethers.provider.getBlock("latest");

        const rawTx = processorUtils.customRawTxToRawTx(transaction);
        const tx = ethers.Transaction.from(rawTx);

        const rlpSignData = transaction.slice(0, -(SIGNATURE_BYTES * 2 + EFFECTIVE_PERCENTAGE_BYTES * 2));
        expect(rlpSignData).to.be.equal(tx.unsignedSerialized);

        expect(tx.to).to.be.equal(firechainZkEVMBridgeContract.target);
        expect(tx.value).to.be.equal(0);
        expect(tx.data).to.be.equal(encodedData);
        expect(tx.gasPrice).to.be.equal(0);
        expect(tx.gasLimit).to.be.equal(30000000);
        expect(tx.nonce).to.be.equal(0);
        expect(tx.chainId).to.be.equal(0);

        const expectedAccInputHash = calculateAccInputHashetrog(
            ethers.ZeroHash,
            ethers.keccak256(transaction),
            await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot(),
            timestampCreatedRollup,
            trustedSequencer.address,
            blockCreatedRollup?.parentHash
        );

        // calcualte accINputHash
        expect(await FirechainZKEVMV2Contract.lastAccInputHash()).to.be.equal(expectedAccInputHash);

        // try verify batches
        const l2txData = "0x123456";
        const maticAmount = ethers.parseEther("1");

        // Approve tokens
        await expect(polTokenContract.connect(admin).approve(FirechainZKEVMV2Contract.target, maticAmount)).to.emit(
            polTokenContract,
            "Approval"
        );

        expect(await FirechainZKEVMV2Contract.calculatePolPerForceBatch()).to.be.equal(0);

        const globalExitRoot = await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        // force Batches
        await expect(FirechainZKEVMV2Contract.forceBatch(l2txData, maticAmount)).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "ForceBatchNotAllowed"
        );

        //await FirechainZKEVMV2Contract.connect(admin).activateForceBatches();
        await polTokenContract.transfer(admin.address, ethers.parseEther("1000"));

        // force Batches
        await expect(FirechainZKEVMV2Contract.forceBatch(l2txData, 0)).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "ForceBatchNotAllowed"
        );

        await expect(FirechainZKEVMV2Contract.connect(admin).forceBatch(l2txData, 0)).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "NotEnoughPOLAmount"
        );

        await expect(
            FirechainZKEVMV2Contract.connect(admin).forceBatch(
                `0x${"00".repeat(_MAX_TRANSACTIONS_BYTE_LENGTH + 1)}`,
                maticAmount
            )
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "TransactionsLengthAboveMax");

        await expect(FirechainZKEVMV2Contract.connect(admin).forceBatch(l2txData, maticAmount))
            .to.emit(FirechainZKEVMV2Contract, "ForceBatch")
            .withArgs(1, globalExitRoot, admin.address, "0x");

        expect(await FirechainZKEVMV2Contract.calculatePolPerForceBatch()).to.be.equal(
            await rollupManagerContract.getForcedBatchFee()
        );
    });

    it("should check forced batches from a contract", async () => {
        // Initialzie using rollup manager
        await ethers.provider.send("hardhat_impersonateAccount", [rollupManagerContract.target]);
        const rolllupManagerSigner = await ethers.getSigner(rollupManagerContract.target as any);
        await expect(
            FirechainZKEVMV2Contract.connect(rolllupManagerSigner).initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                gasTokenAddress,
                urlSequencer,
                networkName,
                {gasPrice: 0}
            )
        ).to.emit(FirechainZKEVMV2Contract, "InitialSequenceBatches");

        const timestampCreatedRollup = (await ethers.provider.getBlock("latest"))?.timestamp;
        const transaction = await FirechainZKEVMV2Contract.generateInitializeTransaction(
            networkID,
            gasTokenAddress,
            gasTokenNetwork,
            "0x" // empty metadata
        );

        // Check transaction
        const bridgeL2Factory = await ethers.getContractFactory("FirechainZkEVMBridgeV2");
        const encodedData = bridgeL2Factory.interface.encodeFunctionData("initialize", [
            networkID,
            gasTokenAddress,
            gasTokenNetwork,
            globalExitRootL2Address,
            ethers.ZeroAddress,
            "0x", // empty metadata
        ]);

        const blockCreatedRollup = await ethers.provider.getBlock("latest");

        const rawTx = processorUtils.customRawTxToRawTx(transaction);
        const tx = ethers.Transaction.from(rawTx);

        const rlpSignData = transaction.slice(0, -(SIGNATURE_BYTES * 2 + EFFECTIVE_PERCENTAGE_BYTES * 2));
        expect(rlpSignData).to.be.equal(tx.unsignedSerialized);

        expect(tx.to).to.be.equal(firechainZkEVMBridgeContract.target);
        expect(tx.value).to.be.equal(0);
        expect(tx.data).to.be.equal(encodedData);
        expect(tx.gasPrice).to.be.equal(0);
        expect(tx.gasLimit).to.be.equal(30000000);
        expect(tx.nonce).to.be.equal(0);
        expect(tx.chainId).to.be.equal(0);

        const expectedAccInputHash = calculateAccInputHashetrog(
            ethers.ZeroHash,
            ethers.keccak256(transaction),
            await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot(),
            timestampCreatedRollup,
            trustedSequencer.address,
            blockCreatedRollup?.parentHash
        );

        // calcualte accINputHash
        expect(await FirechainZKEVMV2Contract.lastAccInputHash()).to.be.equal(expectedAccInputHash);

        // try verify batches
        const l2txData = "0x123456";
        const maticAmount = ethers.parseEther("1");

        expect(await FirechainZKEVMV2Contract.calculatePolPerForceBatch()).to.be.equal(0);

        // deploy sender SC
        const sendDataFactory = await ethers.getContractFactory("SendData");
        const sendDataContract = await sendDataFactory.deploy();
        await sendDataContract.waitForDeployment();

        // Approve matic
        const approveTx = await polTokenContract.approve.populateTransaction(
            FirechainZKEVMV2Contract.target,
            maticAmount
        );
        await sendDataContract.sendData(approveTx.to, approveTx.data);

        // Activate forced batches
        await expect(FirechainZKEVMV2Contract.connect(admin).setForceBatchAddress(sendDataContract.target)).to.emit(
            FirechainZKEVMV2Contract,
            "SetForceBatchAddress"
        );

        await polTokenContract.transfer(sendDataContract.target, ethers.parseEther("1000"));

        const globalExitRoot = await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot();
        const lastForcedBatch = (await FirechainZKEVMV2Contract.lastForceBatch()) + 1n;

        const forceBatchTx = await FirechainZKEVMV2Contract.forceBatch.populateTransaction(l2txData, maticAmount);
        await expect(sendDataContract.sendData(forceBatchTx.to, forceBatchTx.data))
            .to.emit(FirechainZKEVMV2Contract, "ForceBatch")
            .withArgs(lastForcedBatch, globalExitRoot, sendDataContract.target, l2txData);

        expect(await FirechainZKEVMV2Contract.calculatePolPerForceBatch()).to.be.equal(
            await rollupManagerContract.getForcedBatchFee()
        );
    });

    it("should check forced batches from a contract", async () => {
        // Initialzie using rollup manager
        await ethers.provider.send("hardhat_impersonateAccount", [rollupManagerContract.target]);
        const rolllupManagerSigner = await ethers.getSigner(rollupManagerContract.target as any);
        await expect(
            FirechainZKEVMV2Contract.connect(rolllupManagerSigner).initialize(
                admin.address,
                trustedSequencer.address,
                networkID,
                gasTokenAddress,
                urlSequencer,
                networkName,
                {gasPrice: 0}
            )
        ).to.emit(FirechainZKEVMV2Contract, "InitialSequenceBatches");

        const timestampCreatedRollup = (await ethers.provider.getBlock("latest"))?.timestamp;
        const transaction = await FirechainZKEVMV2Contract.generateInitializeTransaction(
            networkID,
            gasTokenAddress,
            gasTokenNetwork,
            "0x" // empty metadata
        );

        // Check transaction
        const bridgeL2Factory = await ethers.getContractFactory("FirechainZkEVMBridgeV2");
        const encodedData = bridgeL2Factory.interface.encodeFunctionData("initialize", [
            networkID,
            gasTokenAddress,
            gasTokenNetwork,
            globalExitRootL2Address,
            ethers.ZeroAddress,
            "0x", // empty metadata
        ]);

        const blockCreatedRollup = await ethers.provider.getBlock("latest");

        const rawTx = processorUtils.customRawTxToRawTx(transaction);
        const tx = ethers.Transaction.from(rawTx);

        const rlpSignData = transaction.slice(0, -(SIGNATURE_BYTES * 2 + EFFECTIVE_PERCENTAGE_BYTES * 2));
        expect(rlpSignData).to.be.equal(tx.unsignedSerialized);

        expect(tx.to).to.be.equal(firechainZkEVMBridgeContract.target);
        expect(tx.value).to.be.equal(0);
        expect(tx.data).to.be.equal(encodedData);
        expect(tx.gasPrice).to.be.equal(0);
        expect(tx.gasLimit).to.be.equal(30000000);
        expect(tx.nonce).to.be.equal(0);
        expect(tx.chainId).to.be.equal(0);

        const expectedAccInputHash = calculateAccInputHashetrog(
            ethers.ZeroHash,
            ethers.keccak256(transaction),
            await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot(),
            timestampCreatedRollup,
            trustedSequencer.address,
            blockCreatedRollup?.parentHash
        );

        // calcualte accINputHash
        expect(await FirechainZKEVMV2Contract.lastAccInputHash()).to.be.equal(expectedAccInputHash);

        // try verify batches
        const l2txData = "0x123456";
        const maticAmount = ethers.parseEther("1");

        // Approve tokens
        await polTokenContract.transfer(admin.address, ethers.parseEther("1000"));
        await expect(polTokenContract.connect(admin).approve(FirechainZKEVMV2Contract.target, maticAmount)).to.emit(
            polTokenContract,
            "Approval"
        );

        expect(await FirechainZKEVMV2Contract.calculatePolPerForceBatch()).to.be.equal(0);
        const globalExitRoot = await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot();

        const adminPolBalance = await polTokenContract.balanceOf(admin.address);
        const forceBatchFee = await rollupManagerContract.getForcedBatchFee();

        await expect(FirechainZKEVMV2Contract.connect(admin).forceBatch(l2txData, maticAmount))
            .to.emit(FirechainZKEVMV2Contract, "ForceBatch")
            .withArgs(1, globalExitRoot, admin.address, "0x");

        const blockForced = await ethers.provider.getBlock("latest");
        const timestampForceBatch = blockForced?.timestamp as any;

        expect(await polTokenContract.balanceOf(admin.address)).to.be.equal(adminPolBalance - forceBatchFee);

        expect(await FirechainZKEVMV2Contract.calculatePolPerForceBatch()).to.be.equal(
            await rollupManagerContract.getForcedBatchFee()
        );

        // Sequence force batches
        const sequenceForced = {
            transactions: l2txData,
            forcedGlobalExitRoot: globalExitRoot,
            forcedTimestamp: timestampForceBatch,
            forcedBlockHashL1: blockForced?.parentHash,
        } as BatchDataStructEtrog;

        // sequence force batch
        await expect(FirechainZKEVMV2Contract.connect(admin).sequenceForceBatches([])).to.be.revertedWithCustomError(
            FirechainZKEVMV2Contract,
            "SequenceZeroBatches"
        );

        // sequence force batch
        const sequencedArray = new Array(_MAX_VERIFY_BATCHES + 1).fill(sequenceForced);

        await expect(
            FirechainZKEVMV2Contract.connect(admin).sequenceForceBatches(sequencedArray)
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "ExceedMaxVerifyBatches");

        // sequence force batch
        await expect(
            FirechainZKEVMV2Contract.connect(admin).sequenceForceBatches([sequenceForced, sequenceForced])
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "ForceBatchesOverflow");

        // sequence force batch
        await expect(
            FirechainZKEVMV2Contract.connect(admin).sequenceForceBatches([sequenceForced])
        ).to.be.revertedWithCustomError(FirechainZKEVMV2Contract, "ForceBatchTimeoutNotExpired");

        // Increment timestamp
        await ethers.provider.send("evm_setNextBlockTimestamp", [timestampForceBatch + FORCE_BATCH_TIMEOUT]);

        // sequence force batch
        await expect(FirechainZKEVMV2Contract.connect(admin).sequenceForceBatches([sequenceForced]))
            .to.emit(FirechainZKEVMV2Contract, "SequenceForceBatches")
            .withArgs(2);

        const expectedAccInputHash3 = calculateAccInputHashetrog(
            expectedAccInputHash,
            ethers.keccak256(l2txData),
            globalExitRoot,
            timestampForceBatch,
            admin.address,
            blockForced?.parentHash
        );

        // calcualte accINputHash
        expect(await FirechainZKEVMV2Contract.lastAccInputHash()).to.be.equal(expectedAccInputHash3);
    });
});

/**
 * Compute accumulateInputHash = Keccak256(oldAccInputHash, batchHashData, globalExitRoot, timestamp, seqAddress)
 * @param {String} oldAccInputHash - old accumulateInputHash
 * @param {String} batchHashData - Batch hash data
 * @param {String} globalExitRoot - Global Exit Root
 * @param {Number} timestamp - Block timestamp
 * @param {String} sequencerAddress - Sequencer address
 * @returns {String} - accumulateInputHash in hex encoding
 */
function calculateAccInputHashetrog(
    oldAccInputHash: any,
    batchHashData: any,
    globalExitRoot: any,
    timestamp: any,
    sequencerAddress: any,
    forcedBlockHash: any
) {
    const hashKeccak = ethers.solidityPackedKeccak256(
        ["bytes32", "bytes32", "bytes32", "uint64", "address", "bytes32"],
        [oldAccInputHash, batchHashData, globalExitRoot, timestamp, sequencerAddress, forcedBlockHash]
    );

    return hashKeccak;
}
