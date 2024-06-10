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

    const tokenName = "Matic Token";
    const tokenSymbol = "MATIC";
    const decimals = 18;
    const tokenInitialBalance = ethers.parseEther("20000000");
    const metadataToken = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "uint8"],
        [tokenName, tokenSymbol, decimals]
    );
    const networkIDMainnet = 0;
    const networkIDRollup = 1;

    const LEAF_TYPE_ASSET = 0;
    const LEAF_TYPE_MESSAGE = 1;

    const firechainZkEVMAddress = ethers.ZeroAddress;

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

        // deploy token
        const maticTokenFactory = await ethers.getContractFactory("ERC20PermitMock");
        polTokenContract = await maticTokenFactory.deploy(
            tokenName,
            tokenSymbol,
            deployer.address,
            tokenInitialBalance
        );
    });

    it("should check the initialize parameters", async () => {
        expect(await firechainZkEVMBridgeContract.globalExitRootManager()).to.be.equal(firechainZkEVMGlobalExitRoot.target);
        expect(await firechainZkEVMBridgeContract.networkID()).to.be.equal(networkIDMainnet);
        expect(await firechainZkEVMBridgeContract.firechainRollupManager()).to.be.equal(rollupManager.address);

        // cannot initialzie again
        await expect(
            firechainZkEVMBridgeContract.initialize(
                networkIDMainnet,
                ethers.ZeroAddress, // zero for ether
                ethers.ZeroAddress, // zero for ether
                firechainZkEVMGlobalExitRoot.target,
                rollupManager.address,
                "0x"
            )
        ).to.be.revertedWith("Initializable: contract is already initialized");
    });

    it("should check bridgeMessageWETH reverts", async () => {
        await expect(
            firechainZkEVMBridgeContract.bridgeMessageWETH(networkIDMainnet, deployer.address, 0, true, "0x")
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "NativeTokenIsEther");
    });

    it("should FirechainZkEVM bridge asset and verify merkle proof", async () => {
        const depositCount = await firechainZkEVMBridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const tokenAddress = polTokenContract.target;
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = metadataToken;
        const metadataHash = ethers.solidityPackedKeccak256(["bytes"], [metadata]);

        const balanceDeployer = await polTokenContract.balanceOf(deployer.address);
        const balanceBridge = await polTokenContract.balanceOf(firechainZkEVMBridgeContract.target);

        const rollupExitRoot = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();

        // create a new deposit
        await expect(polTokenContract.approve(firechainZkEVMBridgeContract.target, amount))
            .to.emit(polTokenContract, "Approval")
            .withArgs(deployer.address, firechainZkEVMBridgeContract.target, amount);

        // pre compute root merkle tree in Js
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash
        );
        merkleTree.add(leafValue);
        const rootJSMainnet = merkleTree.getRoot();

        await expect(
            firechainZkEVMBridgeContract.bridgeAsset(
                destinationNetwork,
                destinationAddress,
                amount,
                tokenAddress,
                true,
                "0x",
                {value: 1}
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "MsgValueNotZero");

        await expect(
            firechainZkEVMBridgeContract.bridgeAsset(
                destinationNetwork,
                destinationAddress,
                amount,
                tokenAddress,
                true,
                "0x"
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "BridgeEvent")
            .withArgs(
                LEAF_TYPE_ASSET,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata,
                depositCount
            )
            .to.emit(firechainZkEVMGlobalExitRoot, "UpdateGlobalExitRoot")
            .withArgs(rootJSMainnet, rollupExitRoot);

        expect(await polTokenContract.balanceOf(deployer.address)).to.be.equal(balanceDeployer - amount);
        expect(await polTokenContract.balanceOf(firechainZkEVMBridgeContract.target)).to.be.equal(balanceBridge + amount);
        expect(await firechainZkEVMBridgeContract.lastUpdatedDepositCount()).to.be.equal(1);

        // check merkle root with SC
        const rootSCMainnet = await firechainZkEVMBridgeContract.getRoot();
        expect(rootSCMainnet).to.be.equal(rootJSMainnet);

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, rootSCMainnet)).to.be.equal(true);
        expect(await firechainZkEVMBridgeContract.verifyMerkleProof(leafValue, proof, index, rootSCMainnet)).to.be.equal(
            true
        );

        const computedGlobalExitRoot = calculateGlobalExitRoot(rootJSMainnet, rollupExitRoot);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());
    });

    it("should FirechainZkEVM bridge asset and verify merkle proof", async () => {
        const depositCount = await firechainZkEVMBridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const tokenAddress = polTokenContract.target;
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = metadataToken;
        const metadataHash = ethers.solidityPackedKeccak256(["bytes"], [metadata]);

        const balanceDeployer = await polTokenContract.balanceOf(deployer.address);
        const balanceBridge = await polTokenContract.balanceOf(firechainZkEVMBridgeContract.target);

        const rollupExitRoot = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();

        // create a new deposit
        await expect(polTokenContract.approve(firechainZkEVMBridgeContract.target, amount))
            .to.emit(polTokenContract, "Approval")
            .withArgs(deployer.address, firechainZkEVMBridgeContract.target, amount);

        // pre compute root merkle tree in Js
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash
        );
        merkleTree.add(leafValue);
        const rootJSMainnet = merkleTree.getRoot();

        await expect(
            firechainZkEVMBridgeContract.bridgeAsset(
                destinationNetwork,
                destinationAddress,
                amount,
                tokenAddress,
                true,
                "0x",
                {value: 1}
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "MsgValueNotZero");

        await expect(
            firechainZkEVMBridgeContract.bridgeAsset(
                destinationNetwork,
                destinationAddress,
                amount,
                tokenAddress,
                true,
                "0x"
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "BridgeEvent")
            .withArgs(
                LEAF_TYPE_ASSET,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata,
                depositCount
            )
            .to.emit(firechainZkEVMGlobalExitRoot, "UpdateGlobalExitRoot")
            .withArgs(rootJSMainnet, rollupExitRoot);

        expect(await polTokenContract.balanceOf(deployer.address)).to.be.equal(balanceDeployer - amount);
        expect(await polTokenContract.balanceOf(firechainZkEVMBridgeContract.target)).to.be.equal(balanceBridge + amount);
        expect(await firechainZkEVMBridgeContract.lastUpdatedDepositCount()).to.be.equal(1);

        // check merkle root with SC
        const rootSCMainnet = await firechainZkEVMBridgeContract.getRoot();
        expect(rootSCMainnet).to.be.equal(rootJSMainnet);

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, rootSCMainnet)).to.be.equal(true);
        expect(await firechainZkEVMBridgeContract.verifyMerkleProof(leafValue, proof, index, rootSCMainnet)).to.be.equal(
            true
        );

        const computedGlobalExitRoot = calculateGlobalExitRoot(rootJSMainnet, rollupExitRoot);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());
    });

    it("should FirechainZkEVMBridge message and verify merkle proof", async () => {
        const depositCount = await firechainZkEVMBridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const originAddress = deployer.address;
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = metadataToken;
        const metadataHash = ethers.solidityPackedKeccak256(["bytes"], [metadata]);
        const rollupExitRoot = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();

        // pre compute root merkle tree in Js
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_MESSAGE,
            originNetwork,
            originAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash
        );
        merkleTree.add(leafValue);
        const rootJSMainnet = merkleTree.getRoot();

        await expect(
            firechainZkEVMBridgeContract.bridgeMessage(networkIDMainnet, destinationAddress, true, "0x")
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "DestinationNetworkInvalid");

        await expect(
            firechainZkEVMBridgeContract.bridgeMessage(destinationNetwork, destinationAddress, true, metadata, {
                value: amount,
            })
        )
            .to.emit(firechainZkEVMBridgeContract, "BridgeEvent")
            .withArgs(
                LEAF_TYPE_MESSAGE,
                originNetwork,
                originAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata,
                depositCount
            );

        // check merkle root with SC
        const rootSCMainnet = await firechainZkEVMBridgeContract.getRoot();
        expect(rootSCMainnet).to.be.equal(rootJSMainnet);

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, rootSCMainnet)).to.be.equal(true);
        expect(await firechainZkEVMBridgeContract.verifyMerkleProof(leafValue, proof, index, rootSCMainnet)).to.be.equal(
            true
        );

        const computedGlobalExitRoot = calculateGlobalExitRoot(rootJSMainnet, rollupExitRoot);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());
    });

    it("should FirechainZkEVM bridge asset and message to check global exit root updates", async () => {
        const depositCount = await firechainZkEVMBridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const tokenAddress = polTokenContract.target;
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = metadataToken;
        const metadataHash = ethers.solidityPackedKeccak256(["bytes"], [metadata]);

        const balanceDeployer = await polTokenContract.balanceOf(deployer.address);
        const balanceBridge = await polTokenContract.balanceOf(firechainZkEVMBridgeContract.target);

        const rollupExitRoot = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();

        // create a new deposit
        await expect(polTokenContract.approve(firechainZkEVMBridgeContract.target, amount))
            .to.emit(polTokenContract, "Approval")
            .withArgs(deployer.address, firechainZkEVMBridgeContract.target, amount);

        // pre compute root merkle tree in Js
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash
        );
        merkleTree.add(leafValue);
        const rootJSMainnet = merkleTree.getRoot();

        await expect(
            firechainZkEVMBridgeContract.bridgeAsset(
                destinationNetwork,
                destinationAddress,
                amount,
                tokenAddress,
                false,
                "0x"
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "BridgeEvent")
            .withArgs(
                LEAF_TYPE_ASSET,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata,
                depositCount
            );

        expect(await polTokenContract.balanceOf(deployer.address)).to.be.equal(balanceDeployer - amount);
        expect(await polTokenContract.balanceOf(firechainZkEVMBridgeContract.target)).to.be.equal(balanceBridge + amount);
        expect(await firechainZkEVMBridgeContract.lastUpdatedDepositCount()).to.be.equal(0);
        expect(await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot()).to.be.equal(ethers.ZeroHash);

        // check merkle root with SC
        const rootSCMainnet = await firechainZkEVMBridgeContract.getRoot();
        expect(rootSCMainnet).to.be.equal(rootJSMainnet);

        // Update global exit root
        await expect(firechainZkEVMBridgeContract.updateGlobalExitRoot())
            .to.emit(firechainZkEVMGlobalExitRoot, "UpdateGlobalExitRoot")
            .withArgs(rootJSMainnet, rollupExitRoot);

        // no state changes since there are not any deposit pending to be updated
        await firechainZkEVMBridgeContract.updateGlobalExitRoot();
        expect(await firechainZkEVMBridgeContract.lastUpdatedDepositCount()).to.be.equal(1);
        expect(await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot()).to.be.equal(rootJSMainnet);

        const computedGlobalExitRoot = calculateGlobalExitRoot(rootJSMainnet, rollupExitRoot);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // bridge message
        await expect(
            firechainZkEVMBridgeContract.bridgeMessage(destinationNetwork, destinationAddress, false, metadata, {
                value: amount,
            })
        )
            .to.emit(firechainZkEVMBridgeContract, "BridgeEvent")
            .withArgs(
                LEAF_TYPE_MESSAGE,
                originNetwork,
                deployer.address,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata,
                1
            );
        expect(await firechainZkEVMBridgeContract.lastUpdatedDepositCount()).to.be.equal(1);
        expect(await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot()).to.be.equal(rootJSMainnet);

        // Update global exit root
        await expect(firechainZkEVMBridgeContract.updateGlobalExitRoot()).to.emit(
            firechainZkEVMGlobalExitRoot,
            "UpdateGlobalExitRoot"
        );

        expect(await firechainZkEVMBridgeContract.lastUpdatedDepositCount()).to.be.equal(2);
        expect(await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot()).to.not.be.equal(rootJSMainnet);

        // Just to have the metric of a low cost bridge Asset
        const tokenAddress2 = ethers.ZeroAddress; // Ether
        const amount2 = ethers.parseEther("10");
        await firechainZkEVMBridgeContract.bridgeAsset(
            destinationNetwork,
            destinationAddress,
            amount2,
            tokenAddress2,
            false,
            "0x",
            {value: amount2}
        );
    });

    it("should claim tokens from Mainnet to Mainnet", async () => {
        const originNetwork = networkIDMainnet;
        const tokenAddress = polTokenContract.target;
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDMainnet;
        const destinationAddress = acc1.address;

        const metadata = metadataToken;
        const metadataHash = ethers.solidityPackedKeccak256(["bytes"], [metadata]);

        const rollupExitRoot = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();

        // compute root merkle tree in Js
        const height = 32;
        const merkleTreeLocal = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash
        );
        merkleTreeLocal.add(leafValue);

        const mainnetExitRoot = merkleTreeLocal.getRoot();
        const indexRollup = 0;

        // check only rollup account with update rollup exit root
        await expect(firechainZkEVMGlobalExitRoot.updateExitRoot(mainnetExitRoot)).to.be.revertedWithCustomError(
            firechainZkEVMGlobalExitRoot,
            "OnlyAllowedContracts"
        );

        // add rollup Merkle root
        await ethers.provider.send("hardhat_impersonateAccount", [firechainZkEVMBridgeContract.target]);
        const bridgemoCK = await ethers.getSigner(firechainZkEVMBridgeContract.target as any);

        // await deployer.sendTransaction({
        //     to: bridgemoCK.address,
        //     value: ethers.parseEther("1"),
        // });

        await expect(firechainZkEVMGlobalExitRoot.connect(bridgemoCK).updateExitRoot(mainnetExitRoot, {gasPrice: 0}))
            .to.emit(firechainZkEVMGlobalExitRoot, "UpdateGlobalExitRoot")
            .withArgs(mainnetExitRoot, rollupExitRoot);

        // check roots
        const rollupExitRootSC = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();
        expect(rollupExitRootSC).to.be.equal(rollupExitRoot);
        const mainnetExitRootSC = await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot();
        expect(mainnetExitRootSC).to.be.equal(mainnetExitRoot);

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRoot, rollupExitRootSC);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // check merkle proof

        // Merkle proof local
        const indexLocal = 0;
        const proofLocal = merkleTreeLocal.getProofTreeByIndex(indexLocal);

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proofLocal, indexLocal, mainnetExitRoot)).to.be.equal(true);

        const globalIndex = computeGlobalIndex(indexLocal, indexRollup, true);

        /*
         * claim
         * Can't claim without tokens
         */
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofLocal,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWith("ERC20: transfer amount exceeds balance");

        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofLocal,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                networkIDRollup,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "DestinationNetworkInvalid");

        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofLocal,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount + 1n,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "InvalidSmtProof");

        // transfer tokens, then claim
        await expect(polTokenContract.transfer(firechainZkEVMBridgeContract.target, amount))
            .to.emit(polTokenContract, "Transfer")
            .withArgs(deployer.address, firechainZkEVMBridgeContract.target, amount);

        expect(false).to.be.equal(await firechainZkEVMBridgeContract.isClaimed(indexLocal, indexRollup + 1));

        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofLocal,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "ClaimEvent")
            .withArgs(globalIndex, originNetwork, tokenAddress, destinationAddress, amount)
            .to.emit(polTokenContract, "Transfer")
            .withArgs(firechainZkEVMBridgeContract.target, acc1.address, amount);

        // Can't claim because nullifier
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofLocal,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "AlreadyClaimed");
        expect(true).to.be.equal(await firechainZkEVMBridgeContract.isClaimed(indexLocal, indexRollup + 1));
    });

    it("should claim tokens from Mainnet to Mainnet", async () => {
        const originNetwork = networkIDMainnet;
        const tokenAddress = polTokenContract.target;
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDMainnet;
        const destinationAddress = acc1.address;

        const metadata = metadataToken;
        const metadataHash = ethers.solidityPackedKeccak256(["bytes"], [metadata]);

        const mainnetExitRoot = await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot();

        // compute root merkle tree in Js
        const height = 32;
        const merkleTreeLocal = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash
        );
        merkleTreeLocal.add(leafValue);

        const rootLocalRollup = merkleTreeLocal.getRoot();
        const indexRollup = 5;

        // Try claim with 10 rollup leafs
        const merkleTreeRollup = new MerkleTreeBridge(height);
        for (let i = 0; i < 10; i++) {
            if (i == indexRollup) {
                merkleTreeRollup.add(rootLocalRollup);
            } else {
                merkleTreeRollup.add(ethers.toBeHex(ethers.toQuantity(ethers.randomBytes(32)), 32));
            }
        }

        const rootRollup = merkleTreeRollup.getRoot();

        // check only rollup account with update rollup exit root
        await expect(firechainZkEVMGlobalExitRoot.updateExitRoot(rootRollup)).to.be.revertedWithCustomError(
            firechainZkEVMGlobalExitRoot,
            "OnlyAllowedContracts"
        );

        // add rollup Merkle root
        await expect(firechainZkEVMGlobalExitRoot.connect(rollupManager).updateExitRoot(rootRollup))
            .to.emit(firechainZkEVMGlobalExitRoot, "UpdateGlobalExitRoot")
            .withArgs(mainnetExitRoot, rootRollup);

        // check roots
        const rollupExitRootSC = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();
        expect(rollupExitRootSC).to.be.equal(rootRollup);

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRoot, rollupExitRootSC);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // check merkle proof

        // Merkle proof local
        const indexLocal = 0;
        const proofLocal = merkleTreeLocal.getProofTreeByIndex(indexLocal);

        // Merkle proof local
        const proofRollup = merkleTreeRollup.getProofTreeByIndex(indexRollup);

        // verify merkle proof
        expect(verifyMerkleProof(rootLocalRollup, proofRollup, indexRollup, rootRollup)).to.be.equal(true);
        expect(
            await firechainZkEVMBridgeContract.verifyMerkleProof(rootLocalRollup, proofRollup, indexRollup, rootRollup)
        ).to.be.equal(true);
        const globalIndex = computeGlobalIndex(indexLocal, indexRollup, false);
        /*
         * claim
         * Can't claim without tokens
         */
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                Number(globalIndex),
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWith("ERC20: transfer amount exceeds balance");

        // transfer tokens, then claim
        await expect(polTokenContract.transfer(firechainZkEVMBridgeContract.target, amount))
            .to.emit(polTokenContract, "Transfer")
            .withArgs(deployer.address, firechainZkEVMBridgeContract.target, amount);

        expect(false).to.be.equal(await firechainZkEVMBridgeContract.isClaimed(indexLocal, indexRollup + 1));

        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "ClaimEvent")
            .withArgs(globalIndex, originNetwork, tokenAddress, destinationAddress, amount)
            .to.emit(polTokenContract, "Transfer")
            .withArgs(firechainZkEVMBridgeContract.target, acc1.address, amount);

        // Can't claim because nullifier
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "AlreadyClaimed");
        expect(true).to.be.equal(await firechainZkEVMBridgeContract.isClaimed(indexLocal, indexRollup + 1));
    });

    it("should claim tokens from Rollup to Mainnet", async () => {
        const originNetwork = networkIDRollup;
        const tokenAddress = polTokenContract.target;
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDMainnet;
        const destinationAddress = deployer.address;

        const metadata = metadataToken;
        const metadataHash = ethers.solidityPackedKeccak256(["bytes"], [metadata]);

        const mainnetExitRoot = await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot();

        // compute root merkle tree in Js
        const height = 32;
        const merkleTreeLocal = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash
        );
        merkleTreeLocal.add(leafValue);
        merkleTreeLocal.add(leafValue);

        const rootLocalRollup = merkleTreeLocal.getRoot();

        // Try claim with 10 rollup leafs
        const merkleTreeRollup = new MerkleTreeBridge(height);
        for (let i = 0; i < 10; i++) {
            merkleTreeRollup.add(rootLocalRollup);
        }

        const rootRollup = merkleTreeRollup.getRoot();

        // check only rollup account with update rollup exit root
        await expect(firechainZkEVMGlobalExitRoot.updateExitRoot(rootRollup)).to.be.revertedWithCustomError(
            firechainZkEVMGlobalExitRoot,
            "OnlyAllowedContracts"
        );

        // add rollup Merkle root
        await expect(firechainZkEVMGlobalExitRoot.connect(rollupManager).updateExitRoot(rootRollup))
            .to.emit(firechainZkEVMGlobalExitRoot, "UpdateGlobalExitRoot")
            .withArgs(mainnetExitRoot, rootRollup);

        // check roots
        const rollupExitRootSC = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();
        expect(rollupExitRootSC).to.be.equal(rootRollup);

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRoot, rollupExitRootSC);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // check merkle proof

        // Merkle proof local
        const indexLocal = 0;
        const proofLocal = merkleTreeLocal.getProofTreeByIndex(indexLocal);

        // Merkle proof local
        const indexRollup = 5;
        const proofRollup = merkleTreeRollup.getProofTreeByIndex(indexRollup);

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proofLocal, indexLocal, rootLocalRollup)).to.be.equal(true);
        expect(verifyMerkleProof(rootLocalRollup, proofRollup, indexRollup, rootRollup)).to.be.equal(true);
        expect(
            await firechainZkEVMBridgeContract.verifyMerkleProof(rootLocalRollup, proofRollup, indexRollup, rootRollup)
        ).to.be.equal(true);
        const globalIndex = computeGlobalIndex(indexLocal, indexRollup, false);

        expect(false).to.be.equal(await firechainZkEVMBridgeContract.isClaimed(indexLocal, indexRollup + 1));

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

        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "ClaimEvent")
            .withArgs(globalIndex, originNetwork, tokenAddress, destinationAddress, amount)
            .to.emit(firechainZkEVMBridgeContract, "NewWrappedToken")
            .withArgs(originNetwork, tokenAddress, precalculateWrappedErc20, metadata)
            .to.emit(newWrappedToken, "Transfer")
            .withArgs(ethers.ZeroAddress, destinationAddress, amount);

        const newTokenInfo = await firechainZkEVMBridgeContract.wrappedTokenToTokenInfo(precalculateWrappedErc20);

        // Use precalculatedWrapperAddress and check if matches
        expect(
            await firechainZkEVMBridgeContract.calculateTokenWrapperAddress(
                networkIDRollup,
                tokenAddress,
                precalculateWrappedErc20
            )
        ).to.be.equal(precalculateWrappedErc20);

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

        // Can't claim because nullifier
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "AlreadyClaimed");
        expect(true).to.be.equal(await firechainZkEVMBridgeContract.isClaimed(indexLocal, indexRollup + 1));

        expect(await newWrappedToken.totalSupply()).to.be.equal(amount);

        // Claim again the other leaf to mint tokens
        const index2 = 1;
        const proof2 = merkleTreeLocal.getProofTreeByIndex(index2);

        expect(verifyMerkleProof(leafValue, proof2, index2, rootLocalRollup)).to.be.equal(true);
        expect(verifyMerkleProof(rootLocalRollup, proofRollup, indexRollup, rollupExitRootSC)).to.be.equal(true);

        const globalIndex2 = computeGlobalIndex(index2, indexRollup, false);
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proof2,
                proofRollup,
                globalIndex2,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "ClaimEvent")
            .withArgs(globalIndex2, originNetwork, tokenAddress, destinationAddress, amount)
            .to.emit(newWrappedToken, "Transfer")
            .withArgs(ethers.ZeroAddress, destinationAddress, amount);

        // Burn Tokens
        const depositCount = await firechainZkEVMBridgeContract.depositCount();
        const wrappedTokenAddress = newWrappedToken.target;
        const newDestinationNetwork = networkIDRollup;

        const rollupExitRoot = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();

        // create a new deposit
        await expect(newWrappedToken.approve(firechainZkEVMBridgeContract.target, amount))
            .to.emit(newWrappedToken, "Approval")
            .withArgs(deployer.address, firechainZkEVMBridgeContract.target, amount);

        /*
         *  pre compute root merkle tree in Js
         * const height = 32;
         */
        const merkleTreeMainnet = new MerkleTreeBridge(height);
        // Imporant calcualte leaf with origin token address no wrapped token address
        const originTokenAddress = tokenAddress;
        const metadataMainnet = metadata; // since the token does not belong to this network
        const metadataHashMainnet = ethers.solidityPackedKeccak256(["bytes"], [metadataMainnet]);

        const leafValueMainnet = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            originTokenAddress,
            newDestinationNetwork,
            destinationAddress,
            amount,
            metadataHashMainnet
        );
        const leafValueMainnetSC = await firechainZkEVMBridgeContract.getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            originTokenAddress,
            newDestinationNetwork,
            destinationAddress,
            amount,
            metadataHashMainnet
        );

        expect(leafValueMainnet).to.be.equal(leafValueMainnetSC);
        merkleTreeMainnet.add(leafValueMainnet);
        const rootJSMainnet = merkleTreeMainnet.getRoot();

        // Tokens are burnt
        expect(await newWrappedToken.totalSupply()).to.be.equal(amount * 2n);
        expect(await newWrappedToken.balanceOf(destinationAddress)).to.be.equal(amount * 2n);
        await expect(
            firechainZkEVMBridgeContract.bridgeAsset(
                newDestinationNetwork,
                destinationAddress,
                amount,
                wrappedTokenAddress,
                true,
                "0x"
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "BridgeEvent")
            .withArgs(
                LEAF_TYPE_ASSET,
                originNetwork,
                originTokenAddress,
                newDestinationNetwork,
                destinationAddress,
                amount,
                metadataMainnet,
                depositCount
            )
            .to.emit(firechainZkEVMGlobalExitRoot, "UpdateGlobalExitRoot")
            .withArgs(rootJSMainnet, rollupExitRoot)
            .to.emit(newWrappedToken, "Transfer")
            .withArgs(deployer.address, ethers.ZeroAddress, amount);

        expect(await newWrappedToken.totalSupply()).to.be.equal(amount);
        expect(await newWrappedToken.balanceOf(deployer.address)).to.be.equal(amount);
        expect(await newWrappedToken.balanceOf(firechainZkEVMBridgeContract.target)).to.be.equal(0);

        // check merkle root with SC
        const rootSCMainnet = await firechainZkEVMBridgeContract.getRoot();
        expect(rootSCMainnet).to.be.equal(rootJSMainnet);

        // check merkle proof
        const proofMainnet = merkleTreeMainnet.getProofTreeByIndex(0);
        const indexMainnet = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValueMainnet, proofMainnet, indexMainnet, rootSCMainnet)).to.be.equal(true);
        expect(
            await firechainZkEVMBridgeContract.verifyMerkleProof(
                leafValueMainnet,
                proofMainnet,
                indexMainnet,
                rootSCMainnet
            )
        ).to.be.equal(true);

        const computedGlobalExitRoot2 = calculateGlobalExitRoot(rootJSMainnet, rollupExitRoot);
        expect(computedGlobalExitRoot2).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());
    });
    it("should claim tokens from Rollup to Mainnet, faling deploy wrapped", async () => {
        const originNetwork = networkIDRollup;
        const tokenAddress = polTokenContract.target;
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDMainnet;
        const destinationAddress = deployer.address;

        const metadata = ethers.hexlify(ethers.randomBytes(40));
        const metadataHash = ethers.solidityPackedKeccak256(["bytes"], [metadata]);

        const mainnetExitRoot = await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot();

        // compute root merkle tree in Js
        const height = 32;
        const merkleTreeLocal = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash
        );
        merkleTreeLocal.add(leafValue);
        merkleTreeLocal.add(leafValue);

        const rootLocalRollup = merkleTreeLocal.getRoot();

        // Try claim with 10 rollup leafs
        const merkleTreeRollup = new MerkleTreeBridge(height);
        for (let i = 0; i < 10; i++) {
            merkleTreeRollup.add(rootLocalRollup);
        }

        const rootRollup = merkleTreeRollup.getRoot();

        // check only rollup account with update rollup exit root
        await expect(firechainZkEVMGlobalExitRoot.updateExitRoot(rootRollup)).to.be.revertedWithCustomError(
            firechainZkEVMGlobalExitRoot,
            "OnlyAllowedContracts"
        );

        // add rollup Merkle root
        await expect(firechainZkEVMGlobalExitRoot.connect(rollupManager).updateExitRoot(rootRollup))
            .to.emit(firechainZkEVMGlobalExitRoot, "UpdateGlobalExitRoot")
            .withArgs(mainnetExitRoot, rootRollup);

        // check roots
        const rollupExitRootSC = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();
        expect(rollupExitRootSC).to.be.equal(rootRollup);

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRoot, rollupExitRootSC);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // check merkle proof

        // Merkle proof local
        const indexLocal = 0;
        const proofLocal = merkleTreeLocal.getProofTreeByIndex(indexLocal);

        // Merkle proof local
        const indexRollup = 5;
        const proofRollup = merkleTreeRollup.getProofTreeByIndex(indexRollup);

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proofLocal, indexLocal, rootLocalRollup)).to.be.equal(true);
        expect(verifyMerkleProof(rootLocalRollup, proofRollup, indexRollup, rootRollup)).to.be.equal(true);
        expect(
            await firechainZkEVMBridgeContract.verifyMerkleProof(rootLocalRollup, proofRollup, indexRollup, rootRollup)
        ).to.be.equal(true);
        const globalIndex = computeGlobalIndex(indexLocal, indexRollup, false);

        expect(false).to.be.equal(await firechainZkEVMBridgeContract.isClaimed(indexLocal, indexRollup + 1));

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

        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "FailedTokenWrappedDeployment");
    });
    it("should FirechainZkEVMBridge and sync the current root with events", async () => {
        const depositCount = await firechainZkEVMBridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const tokenAddress = ethers.ZeroAddress; // Ether
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = "0x"; // since is ether does not have metadata

        // create 3 new deposit
        await expect(
            firechainZkEVMBridgeContract.bridgeAsset(
                destinationNetwork,
                destinationAddress,
                amount,
                tokenAddress,
                true,
                "0x",
                {value: amount}
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "BridgeEvent")
            .withArgs(
                LEAF_TYPE_ASSET,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata,
                depositCount
            );

        await expect(
            firechainZkEVMBridgeContract.bridgeAsset(
                destinationNetwork,
                destinationAddress,
                amount,
                tokenAddress,
                true,
                "0x",
                {value: amount}
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "BridgeEvent")
            .withArgs(
                LEAF_TYPE_ASSET,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata,
                depositCount + 1n
            );

        await expect(
            firechainZkEVMBridgeContract.bridgeAsset(
                destinationNetwork,
                destinationAddress,
                amount,
                tokenAddress,
                true,
                "0x",
                {value: amount}
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "BridgeEvent")
            .withArgs(
                LEAF_TYPE_ASSET,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata,
                depositCount + 2n
            );

        // Prepare merkle tree
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);

        // Get the deposit's events
        const filter = firechainZkEVMBridgeContract.filters.BridgeEvent(
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined
        );
        const events = await firechainZkEVMBridgeContract.queryFilter(filter, 0, "latest");
        events.forEach((e) => {
            const {args} = e;
            const leafValue = getLeafValue(
                args.leafType,
                args.originNetwork,
                args.originAddress,
                args.destinationNetwork,
                args.destinationAddress,
                args.amount,
                ethers.solidityPackedKeccak256(["bytes"], [args.metadata])
            );
            merkleTree.add(leafValue);
        });

        // Check merkle root with SC
        const rootSC = await firechainZkEVMBridgeContract.getRoot();
        const rootJS = merkleTree.getRoot();

        expect(rootSC).to.be.equal(rootJS);
    });

    it("should claim testing all the asserts", async () => {
        // Add a claim leaf to rollup exit tree
        const originNetwork = networkIDMainnet;
        const tokenAddress = polTokenContract.target;
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDMainnet;
        const destinationAddress = deployer.address;

        const metadata = metadataToken;
        const metadataHash = ethers.solidityPackedKeccak256(["bytes"], [metadata]);

        const mainnetExitRoot = await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot();

        // compute root merkle tree in Js
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash
        );
        merkleTree.add(leafValue);

        // check merkle root with SC
        const rootJSRollup = merkleTree.getRoot();

        // Try claim with 10 rollup leafs
        const merkleTreeRollup = new MerkleTreeBridge(height);
        merkleTreeRollup.add(rootJSRollup);
        const rollupRoot = merkleTreeRollup.getRoot();

        // add rollup Merkle root
        await expect(firechainZkEVMGlobalExitRoot.connect(rollupManager).updateExitRoot(rollupRoot))
            .to.emit(firechainZkEVMGlobalExitRoot, "UpdateGlobalExitRoot")
            .withArgs(mainnetExitRoot, rollupRoot);

        // check roots
        const rollupExitRootSC = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();
        expect(rollupExitRootSC).to.be.equal(rollupRoot);

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRoot, rollupExitRootSC);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // check merkle proof
        const index = 0;
        const proofLocal = merkleTree.getProofTreeByIndex(0);
        const proofRollup = merkleTreeRollup.getProofTreeByIndex(0);

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proofLocal, index, rootJSRollup)).to.be.equal(true);
        expect(
            await firechainZkEVMBridgeContract.verifyMerkleProof(leafValue, proofLocal, index, rootJSRollup)
        ).to.be.equal(true);

        const globalIndex = computeGlobalIndex(index, index, false);
        // Can't claim without tokens
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWith("ERC20: transfer amount exceeds balance");

        // transfer tokens, then claim
        await expect(polTokenContract.transfer(firechainZkEVMBridgeContract.target, amount))
            .to.emit(polTokenContract, "Transfer")
            .withArgs(deployer.address, firechainZkEVMBridgeContract.target, amount);

        // Check Destination network does not match assert
        // await expect(
        //     firechainZkEVMBridgeContract.claimAsset(
        //         proofLocal,
        //         proofRollup,
        //         globalIndex,
        //         mainnetExitRoot,
        //         rollupExitRootSC,
        //         originNetwork,
        //         tokenAddress,
        //         destinationNetwork,
        //         destinationAddress,
        //         amount,
        //         metadata
        //     )
        // ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "DestinationNetworkInvalid");

        // Check GlobalExitRoot invalid assert
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                mainnetExitRoot,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "GlobalExitRootInvalid");

        // Check Invalid smt proof assert
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex + 1n,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "InvalidSmtProof");

        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "ClaimEvent")
            .withArgs(index, originNetwork, tokenAddress, destinationAddress, amount)
            .to.emit(polTokenContract, "Transfer")
            .withArgs(firechainZkEVMBridgeContract.target, deployer.address, amount);

        // Check Already claimed_claim
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "AlreadyClaimed");
    });

    it("should claim ether", async () => {
        // Add a claim leaf to rollup exit tree
        const originNetwork = networkIDMainnet;
        const tokenAddress = ethers.ZeroAddress; // ether
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDMainnet;
        const destinationAddress = deployer.address;

        const metadata = "0x"; // since is ether does not have metadata
        const metadataHash = ethers.solidityPackedKeccak256(["bytes"], [metadata]);

        const mainnetExitRoot = await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot();

        // compute root merkle tree in Js
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_ASSET,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash
        );
        merkleTree.add(leafValue);

        // check merkle root with SC
        const rootJSRollup = merkleTree.getRoot();
        const merkleTreeRollup = new MerkleTreeBridge(height);
        merkleTreeRollup.add(rootJSRollup);
        const rollupRoot = merkleTreeRollup.getRoot();

        // add rollup Merkle root
        await expect(firechainZkEVMGlobalExitRoot.connect(rollupManager).updateExitRoot(rollupRoot))
            .to.emit(firechainZkEVMGlobalExitRoot, "UpdateGlobalExitRoot")
            .withArgs(mainnetExitRoot, rollupRoot);

        // check roots
        const rollupExitRootSC = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();
        expect(rollupExitRootSC).to.be.equal(rollupRoot);

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRoot, rollupExitRootSC);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // check merkle proof
        const index = 0;
        const proofLocal = merkleTree.getProofTreeByIndex(0);
        const proofRollup = merkleTreeRollup.getProofTreeByIndex(0);
        const globalIndex = computeGlobalIndex(index, index, false);

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proofLocal, index, rootJSRollup)).to.be.equal(true);
        expect(
            await firechainZkEVMBridgeContract.verifyMerkleProof(leafValue, proofLocal, index, rootJSRollup)
        ).to.be.equal(true);

        /*
         * claim
         * Can't claim without ether
         */
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "EtherTransferFailed");

        const balanceDeployer = await ethers.provider.getBalance(deployer.address);
        /*
         * Create a deposit to add ether to the FirechainZkEVMBridge
         * Check deposit amount ether asserts
         */
        // await expect(
        //     firechainZkEVMBridgeContract.bridgeAsset(
        //         networkIDRollup,
        //         destinationAddress,
        //         amount,
        //         tokenAddress,
        //         true,
        //         "0x",
        //         {value: ethers.parseEther("100")}
        //     )
        // ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "AmountDoesNotMatchMsgValue");

        // Check mainnet destination assert
        await expect(
            firechainZkEVMBridgeContract.bridgeAsset(
                networkIDMainnet,
                destinationAddress,
                amount,
                tokenAddress,
                true,
                "0x",
                {value: amount}
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "DestinationNetworkInvalid");

        // This is used just to pay ether to the FirechainZkEVMBridge smart contract and be able to claim it afterwards.
        expect(
            await firechainZkEVMBridgeContract.bridgeAsset(
                networkIDRollup,
                destinationAddress,
                amount,
                tokenAddress,
                true,
                "0x",
                {value: amount}
            )
        );

        // Check balances before claim
        expect(await ethers.provider.getBalance(firechainZkEVMBridgeContract.target)).to.be.equal(amount);
        expect(await ethers.provider.getBalance(deployer.address)).to.be.lte(balanceDeployer - amount);

        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "ClaimEvent")
            .withArgs(index, originNetwork, tokenAddress, destinationAddress, amount);

        // Check balances after claim
        expect(await ethers.provider.getBalance(firechainZkEVMBridgeContract.target)).to.be.equal(ethers.parseEther("0"));
        expect(await ethers.provider.getBalance(deployer.address)).to.be.lte(balanceDeployer);

        // Can't claim because nullifier
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "AlreadyClaimed");
    });

    it("should claim message", async () => {
        // Add a claim leaf to rollup exit tree
        const originNetwork = networkIDMainnet;
        const tokenAddress = ethers.ZeroAddress; // ether
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDMainnet;
        const destinationAddress = deployer.address;

        const metadata = "0x176923791298713271763697869132"; // since is ether does not have metadata
        const metadataHash = ethers.solidityPackedKeccak256(["bytes"], [metadata]);

        const mainnetExitRoot = await firechainZkEVMGlobalExitRoot.lastMainnetExitRoot();

        // compute root merkle tree in Js
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);
        const leafValue = getLeafValue(
            LEAF_TYPE_MESSAGE,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadataHash
        );
        merkleTree.add(leafValue);

        // check merkle root with SC
        const rootJSRollup = merkleTree.getRoot();
        const merkleTreeRollup = new MerkleTreeBridge(height);
        merkleTreeRollup.add(rootJSRollup);
        const rollupRoot = merkleTreeRollup.getRoot();

        // add rollup Merkle root
        await expect(firechainZkEVMGlobalExitRoot.connect(rollupManager).updateExitRoot(rollupRoot))
            .to.emit(firechainZkEVMGlobalExitRoot, "UpdateGlobalExitRoot")
            .withArgs(mainnetExitRoot, rollupRoot);

        // check roots
        const rollupExitRootSC = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();
        expect(rollupExitRootSC).to.be.equal(rollupRoot);

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRoot, rollupExitRootSC);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // check merkle proof
        const index = 0;
        const proofLocal = merkleTree.getProofTreeByIndex(0);
        const proofRollup = merkleTreeRollup.getProofTreeByIndex(0);
        const globalIndex = computeGlobalIndex(index, index, false);

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proofLocal, index, rootJSRollup)).to.be.equal(true);
        expect(
            await firechainZkEVMBridgeContract.verifyMerkleProof(leafValue, proofLocal, index, rootJSRollup)
        ).to.be.equal(true);

        /*
         * claim
         * Can't claim a message as an assets
         */
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "InvalidSmtProof");

        /*
         * claim
         * Can't claim invalid destination network
         */
        await expect(
            firechainZkEVMBridgeContract.claimMessage(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                networkIDRollup,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "DestinationNetworkInvalid");

        /*
         * claim
         * Can't claim without ether
         */
        await expect(
            firechainZkEVMBridgeContract.claimMessage(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "MessageFailed");

        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                networkIDRollup,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "DestinationNetworkInvalid");

        const balanceDeployer = await ethers.provider.getBalance(deployer.address);
        /*
         * Create a deposit to add ether to the FirechainZkEVMBridge
         * Check deposit amount ether asserts
         */
        await expect(
            firechainZkEVMBridgeContract.bridgeAsset(
                networkIDRollup,
                destinationAddress,
                amount,
                tokenAddress,
                true,
                "0x",
                {value: ethers.parseEther("100")}
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "AmountDoesNotMatchMsgValue");

        // Check mainnet destination assert
        await expect(
            firechainZkEVMBridgeContract.bridgeAsset(
                networkIDMainnet,
                destinationAddress,
                amount,
                tokenAddress,
                true,
                "0x",
                {value: amount}
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "DestinationNetworkInvalid");

        // This is used just to pay ether to the FirechainZkEVMBridge smart contract and be able to claim it afterwards.
        expect(
            await firechainZkEVMBridgeContract.bridgeAsset(
                networkIDRollup,
                destinationAddress,
                amount,
                tokenAddress,
                true,
                "0x",
                {value: amount}
            )
        );

        // Check balances before claim
        expect(await ethers.provider.getBalance(firechainZkEVMBridgeContract.target)).to.be.equal(amount);
        expect(await ethers.provider.getBalance(deployer.address)).to.be.lte(balanceDeployer - amount);

        // Check mainnet destination assert
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "InvalidSmtProof");

        await expect(
            firechainZkEVMBridgeContract.claimMessage(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        )
            .to.emit(firechainZkEVMBridgeContract, "ClaimEvent")
            .withArgs(index, originNetwork, tokenAddress, destinationAddress, amount);

        // Check balances after claim
        expect(await ethers.provider.getBalance(firechainZkEVMBridgeContract.target)).to.be.equal(ethers.parseEther("0"));
        expect(await ethers.provider.getBalance(deployer.address)).to.be.lte(balanceDeployer);

        // Can't claim because nullifier
        await expect(
            firechainZkEVMBridgeContract.claimMessage(
                proofLocal,
                proofRollup,
                globalIndex,
                mainnetExitRoot,
                rollupExitRootSC,
                originNetwork,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "AlreadyClaimed");
    });

    it("should test emergency state", async () => {
        await expect(firechainZkEVMBridgeContract.activateEmergencyState()).to.be.revertedWithCustomError(
            firechainZkEVMBridgeContract,
            "OnlyRollupManager"
        );

        await expect(firechainZkEVMBridgeContract.connect(rollupManager).activateEmergencyState()).to.emit(
            firechainZkEVMBridgeContract,
            "EmergencyStateActivated"
        );

        const tokenAddress = polTokenContract.target;
        const amount = ethers.parseEther("10");
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = metadataToken;

        await expect(
            firechainZkEVMBridgeContract.bridgeAsset(
                destinationNetwork,
                destinationAddress,
                amount,
                tokenAddress,
                true,
                "0x"
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "OnlyNotEmergencyState");

        await expect(
            firechainZkEVMBridgeContract.bridgeMessage(destinationNetwork, destinationAddress, true, "0x")
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "OnlyNotEmergencyState");

        await expect(
            firechainZkEVMBridgeContract.bridgeMessageWETH(destinationNetwork, destinationAddress, amount, true, "0x")
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "OnlyNotEmergencyState");

        const mockMerkleProof = new Array(32).fill(ethers.ZeroHash) as any;
        await expect(
            firechainZkEVMBridgeContract.claimAsset(
                mockMerkleProof,
                mockMerkleProof,
                ethers.ZeroHash,
                ethers.ZeroHash,
                ethers.ZeroHash,
                0,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "OnlyNotEmergencyState");

        await expect(
            firechainZkEVMBridgeContract.claimMessage(
                mockMerkleProof,
                mockMerkleProof,
                ethers.ZeroHash,
                ethers.ZeroHash,
                ethers.ZeroHash,
                0,
                tokenAddress,
                destinationNetwork,
                destinationAddress,
                amount,
                metadata
            )
        ).to.be.revertedWithCustomError(firechainZkEVMBridgeContract, "OnlyNotEmergencyState");
    });
});
