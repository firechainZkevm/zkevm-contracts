const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const MerkleTreeBridge = require('@0xpolygonhermez/zkevm-commonjs').MTBridge;
const {
    verifyMerkleProof,
    getLeafValue,
} = require('@0xpolygonhermez/zkevm-commonjs').mtBridgeUtils;

const {
    createPermitSignature,
    ifacePermit,
    createPermitSignatureDaiType,
    ifacePermitDAI,
    createPermitSignatureUniType,
} = require('../../src/permit-helper');

function calculateGlobalExitRoot(mainnetExitRoot, rollupExitRoot) {
    return ethers.solidityPackedKeccak256(['bytes32', 'bytes32'], [mainnetExitRoot, rollupExitRoot]);
}

describe('FirechainZkEVMBridge Contract Permit tests', () => {
    let deployer;
    let rollup;

    let firechainZkEVMGlobalExitRoot;
    let firechainZkEVMBridgeContract;
    let tokenContract;

    const tokenName = 'Matic Token';
    const tokenSymbol = 'MATIC';
    const decimals = 18;
    const tokenInitialBalance = ethers.parseEther('20000000');
    const metadataToken = ethers.AbiCoder.defaultAbiCoder().encode(
        ['string', 'string', 'uint8'],
        [tokenName, tokenSymbol, decimals],
    );

    const networkIDMainnet = 0;
    const networkIDRollup = 1;
    const LEAF_TYPE_ASSET = 0;

    const firechainZkEVMAddress = ethers.ZeroAddress;

    beforeEach('Deploy contracts', async () => {
        // load signers
        [deployer, rollup] = await ethers.getSigners();

        // deploy FirechainZkEVMBridge
        const firechainZkEVMBridgeFactory = await ethers.getContractFactory('FirechainZkEVMBridge');
        firechainZkEVMBridgeContract = await upgrades.deployProxy(firechainZkEVMBridgeFactory, [], { initializer: false });

        // deploy global exit root manager
        const firechainZkEVMGlobalExitRootFactory = await ethers.getContractFactory('FirechainZkEVMGlobalExitRoot');
        firechainZkEVMGlobalExitRoot = await firechainZkEVMGlobalExitRootFactory.deploy(rollup.address, firechainZkEVMBridgeContract.address);

        await firechainZkEVMBridgeContract.initialize(networkIDMainnet, firechainZkEVMGlobalExitRoot.address, firechainZkEVMAddress);

        // deploy token
        const maticTokenFactory = await ethers.getContractFactory('TokenWrapped');
        tokenContract = await maticTokenFactory.deploy(
            tokenName,
            tokenSymbol,
            decimals,
        );
        await tokenContract.deployed();

        await tokenContract.mint(deployer.address, tokenInitialBalance);
    });

    it('should FirechainZkEVMBridge and with permit eip-2612 compilant', async () => {
        const depositCount = await firechainZkEVMBridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const tokenAddress = tokenContract.address;
        const amount = ethers.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = metadataToken;
        const metadataHash = ethers.solidityPackedKeccak256(['bytes'], [metadata]);

        const balanceDeployer = await tokenContract.balanceOf(deployer.address);
        const balanceBridge = await tokenContract.balanceOf(firechainZkEVMBridgeContract.address);

        const rollupExitRoot = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();

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
            metadataHash,
        );
        merkleTree.add(leafValue);
        const rootJSMainnet = merkleTree.getRoot();

        await expect(firechainZkEVMBridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, '0x'))
            .to.be.revertedWith('ERC20: insufficient allowance');

        // user permit
        const nonce = await tokenContract.nonces(deployer.address);
        const deadline = ethers.MaxUint256;
        const { chainId } = await ethers.provider.getNetwork();

        const { v, r, s } = await createPermitSignature(
            tokenContract,
            deployer,
            firechainZkEVMBridgeContract.address,
            amount,
            nonce,
            deadline,
            chainId,
        );

        const dataPermit = ifacePermit.encodeFunctionData('permit', [
            deployer.address,
            firechainZkEVMBridgeContract.address,
            amount,
            deadline,
            v,
            r,
            s,
        ]);

        await expect(firechainZkEVMBridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, dataPermit))
            .to.emit(firechainZkEVMBridgeContract, 'BridgeEvent')
            .withArgs(originNetwork, tokenAddress, destinationNetwork, destinationAddress, amount, metadata, depositCount)
            .to.emit(firechainZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(rootJSMainnet, rollupExitRoot);

        expect(await tokenContract.balanceOf(deployer.address)).to.be.equal(balanceDeployer.sub(amount));
        expect(await tokenContract.balanceOf(firechainZkEVMBridgeContract.address)).to.be.equal(balanceBridge.add(amount));

        // check merkle root with SC
        const rootSCMainnet = await firechainZkEVMBridgeContract.getDepositRoot();
        expect(rootSCMainnet).to.be.equal(rootJSMainnet);

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, rootSCMainnet)).to.be.equal(true);
        expect(await firechainZkEVMBridgeContract.verifyMerkleProof(
            leafValue,
            proof,
            index,
            rootSCMainnet,
        )).to.be.equal(true);

        const computedGlobalExitRoot = calculateGlobalExitRoot(rootJSMainnet, rollupExitRoot);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());
    });

    it('should FirechainZkEVMBridge with permit DAI type contracts', async () => {
        const { chainId } = await ethers.provider.getNetwork();
        const daiTokenFactory = await ethers.getContractFactory('Dai');
        const daiContract = await daiTokenFactory.deploy(
            chainId,
        );
        await daiContract.deployed();
        await daiContract.mint(deployer.address, ethers.parseEther('100'));

        const depositCount = await firechainZkEVMBridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const tokenAddress = daiContract.address;
        const amount = ethers.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = ethers.AbiCoder.defaultAbiCoder().encode(
            ['string', 'string', 'uint8'],
            [await daiContract.name(), await daiContract.symbol(), await daiContract.decimals()],
        );
        const metadataHash = ethers.solidityPackedKeccak256(['bytes'], [metadata]);

        const balanceDeployer = await daiContract.balanceOf(deployer.address);
        const balanceBridge = await daiContract.balanceOf(firechainZkEVMBridgeContract.address);

        const rollupExitRoot = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();

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
            metadataHash,
        );
        merkleTree.add(leafValue);
        const rootJSMainnet = merkleTree.getRoot();

        await expect(firechainZkEVMBridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, '0x'))
            .to.be.revertedWith('Dai/insufficient-allowance');

        // user permit
        const nonce = await daiContract.nonces(deployer.address);
        const deadline = ethers.MaxUint256;

        const { v, r, s } = await createPermitSignatureDaiType(
            daiContract,
            deployer,
            firechainZkEVMBridgeContract.address,
            nonce,
            deadline,
            chainId,
        );
        const dataPermit = ifacePermitDAI.encodeFunctionData('permit', [
            deployer.address,
            firechainZkEVMBridgeContract.address,
            nonce,
            deadline,
            true,
            v,
            r,
            s,
        ]);

        await expect(firechainZkEVMBridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, dataPermit))
            .to.emit(firechainZkEVMBridgeContract, 'BridgeEvent')
            .withArgs(originNetwork, tokenAddress, destinationNetwork, destinationAddress, amount, metadata, depositCount)
            .to.emit(firechainZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(rootJSMainnet, rollupExitRoot);

        expect(await daiContract.balanceOf(deployer.address)).to.be.equal(balanceDeployer.sub(amount));
        expect(await daiContract.balanceOf(firechainZkEVMBridgeContract.address)).to.be.equal(balanceBridge.add(amount));

        // check merkle root with SC
        const rootSCMainnet = await firechainZkEVMBridgeContract.getDepositRoot();
        expect(rootSCMainnet).to.be.equal(rootJSMainnet);

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, rootSCMainnet)).to.be.equal(true);
        expect(await firechainZkEVMBridgeContract.verifyMerkleProof(
            leafValue,
            proof,
            index,
            rootSCMainnet,
        )).to.be.equal(true);

        const computedGlobalExitRoot = calculateGlobalExitRoot(rootJSMainnet, rollupExitRoot);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());
    });

    it('should FirechainZkEVMBridge with permit UNI type contracts', async () => {
        const uniTokenFactory = await ethers.getContractFactory('Uni');
        const uniContract = await uniTokenFactory.deploy(
            deployer.address,
            deployer.address,
            (await ethers.provider.getBlock()).timestamp + 1,
        );
        await uniContract.deployed();
        await uniContract.mint(deployer.address, ethers.parseEther('100'));

        const depositCount = await firechainZkEVMBridgeContract.depositCount();
        const originNetwork = networkIDMainnet;
        const tokenAddress = uniContract.address;
        const amount = ethers.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = deployer.address;

        const metadata = ethers.AbiCoder.defaultAbiCoder().encode(
            ['string', 'string', 'uint8'],
            [await uniContract.name(), await uniContract.symbol(), await uniContract.decimals()],
        );
        const metadataHash = ethers.solidityPackedKeccak256(['bytes'], [metadata]);

        const balanceDeployer = await uniContract.balanceOf(deployer.address);
        const balanceBridge = await uniContract.balanceOf(firechainZkEVMBridgeContract.address);

        const rollupExitRoot = await firechainZkEVMGlobalExitRoot.lastRollupExitRoot();

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
            metadataHash,
        );
        merkleTree.add(leafValue);
        const rootJSMainnet = merkleTree.getRoot();

        await expect(firechainZkEVMBridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, '0x'))
            .to.be.revertedWith('Uni::transferFrom: transfer amount exceeds spender allowance');

        // user permit
        const nonce = await uniContract.nonces(deployer.address);
        const deadline = ethers.MaxUint256;
        const { chainId } = await ethers.provider.getNetwork();

        const { v, r, s } = await createPermitSignatureUniType(
            uniContract,
            deployer,
            firechainZkEVMBridgeContract.address,
            amount,
            nonce,
            deadline,
            chainId,
        );
        const dataPermit = ifacePermit.encodeFunctionData('permit', [
            deployer.address,
            firechainZkEVMBridgeContract.address,
            amount,
            deadline,
            v,
            r,
            s,
        ]);

        await expect(firechainZkEVMBridgeContract.bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, dataPermit))
            .to.emit(firechainZkEVMBridgeContract, 'BridgeEvent')
            .withArgs(originNetwork, tokenAddress, destinationNetwork, destinationAddress, amount, metadata, depositCount)
            .to.emit(firechainZkEVMGlobalExitRoot, 'UpdateGlobalExitRoot')
            .withArgs(rootJSMainnet, rollupExitRoot);

        expect(await uniContract.balanceOf(deployer.address)).to.be.equal(balanceDeployer.sub(amount));
        expect(await uniContract.balanceOf(firechainZkEVMBridgeContract.address)).to.be.equal(balanceBridge.add(amount));

        // check merkle root with SC
        const rootSCMainnet = await firechainZkEVMBridgeContract.getDepositRoot();
        expect(rootSCMainnet).to.be.equal(rootJSMainnet);

        // check merkle proof
        const proof = merkleTree.getProofTreeByIndex(0);
        const index = 0;

        // verify merkle proof
        expect(verifyMerkleProof(leafValue, proof, index, rootSCMainnet)).to.be.equal(true);
        expect(await firechainZkEVMBridgeContract.verifyMerkleProof(
            leafValue,
            proof,
            index,
            rootSCMainnet,
        )).to.be.equal(true);

        const computedGlobalExitRoot = calculateGlobalExitRoot(rootJSMainnet, rollupExitRoot);
        expect(computedGlobalExitRoot).to.be.equal(await firechainZkEVMGlobalExitRoot.getLastGlobalExitRoot());
    });
});
