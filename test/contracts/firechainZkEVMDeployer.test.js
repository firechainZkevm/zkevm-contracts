/* eslint-disable no-plusplus, no-await-in-loop */
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

describe('Firechain ZK-EVM Deployer', () => {
    let deployer; let
        owner;
    let fyrechainZKEVMDeployerContract;

    const maticTokenName = 'Matic Token';
    const maticTokenSymbol = 'MATIC';
    const maticTokenInitialBalance = ethers.parseEther('20000000');

    beforeEach('Deploy contract', async () => {
        upgrades.silenceWarnings();

        // load signers
        [deployer, owner] = await ethers.getSigners();

        // deploy mock verifier
        const FyrechainZKEVMDeployerFactory = await ethers.getContractFactory(
            'FirechainZkEVMDeployer',
        );
        fyrechainZKEVMDeployerContract = await FyrechainZKEVMDeployerFactory.deploy(owner.address);
        await fyrechainZKEVMDeployerContract.deployed();
    });

    it('should check the owner', async () => {
        expect(await fyrechainZKEVMDeployerContract.owner()).to.be.equal(owner.address);
    });

    it('should check to deploy a simple contract and call it', async () => {
        const OZERC20PresetFactory = await ethers.getContractFactory(
            'ERC20PresetFixedSupply',
        );

        const salt = ethers.HashZero;

        // Encode deploy transaction
        const deployTransactionERC20 = (OZERC20PresetFactory.getDeployTransaction(
            maticTokenName,
            maticTokenSymbol,
            maticTokenInitialBalance,
            owner.address,
        )).data;
        const hashInitCode = ethers.solidityPackedKeccak256(['bytes'], [deployTransactionERC20]);

        // Precalculate create2 address
        const precalculateTokenDeployed = await ethers.getCreate2Address(fyrechainZKEVMDeployerContract.address, salt, hashInitCode);
        expect(await fyrechainZKEVMDeployerContract.predictDeterministicAddress(
            salt,
            hashInitCode,
        )).to.be.equal(precalculateTokenDeployed);

        const amount = 0;
        await expect(fyrechainZKEVMDeployerContract.connect(deployer).deployDeterministic(
            amount,
            salt,
            deployTransactionERC20,
        )).to.be.revertedWith('Ownable');

        // Deploy using create2
        await expect(fyrechainZKEVMDeployerContract.connect(owner).deployDeterministic(
            amount,
            salt,
            deployTransactionERC20,
        )).to.emit(fyrechainZKEVMDeployerContract, 'NewDeterministicDeployment').withArgs(precalculateTokenDeployed);

        const dataCall = OZERC20PresetFactory.interface.encodeFunctionData('transfer', [owner.address, ethers.parseEther('1')]);
        // Check deployed contract
        const instanceToken = OZERC20PresetFactory.attach(precalculateTokenDeployed);
        expect(await instanceToken.balanceOf(owner.address)).to.be.equal(maticTokenInitialBalance);

        await expect(fyrechainZKEVMDeployerContract.functionCall(
            precalculateTokenDeployed,
            dataCall,
            1, // amount
        )).to.be.revertedWith('Ownable');

        await expect(fyrechainZKEVMDeployerContract.connect(owner).functionCall(
            precalculateTokenDeployed,
            dataCall,
            1, // amount
        )).to.be.revertedWith('Address: insufficient balance for call');

        await expect(fyrechainZKEVMDeployerContract.connect(owner).functionCall(
            precalculateTokenDeployed,
            dataCall,
            1, // amount
            { value: 1 },
        )).to.be.revertedWith('Address: low-level call with value failed');

        await expect(fyrechainZKEVMDeployerContract.connect(owner).functionCall(
            precalculateTokenDeployed,
            dataCall,
            0,
        )).to.be.revertedWith('ERC20: transfer amount exceeds balance');

        // Transfer tokens first
        await instanceToken.connect(owner).transfer(fyrechainZKEVMDeployerContract.address, ethers.parseEther('1'));
        await expect(fyrechainZKEVMDeployerContract.connect(owner).functionCall(
            precalculateTokenDeployed,
            dataCall,
            0, // amount
        )).to.emit(fyrechainZKEVMDeployerContract, 'FunctionCall');
    });

    it('should check to deploy a simple contract and call it', async () => {
        const OZERC20PresetFactory = await ethers.getContractFactory(
            'ERC20PresetFixedSupply',
        );

        const salt = ethers.HashZero;

        // Encode deploy transaction
        const deployTransactionERC20 = (OZERC20PresetFactory.getDeployTransaction(
            maticTokenName,
            maticTokenSymbol,
            maticTokenInitialBalance,
            fyrechainZKEVMDeployerContract.address,
        )).data;

        const hashInitCode = ethers.solidityPackedKeccak256(['bytes'], [deployTransactionERC20]);

        // Precalculate create2 address
        const precalculateTokenDeployed = await ethers.getCreate2Address(fyrechainZKEVMDeployerContract.address, salt, hashInitCode);
        const dataCall = OZERC20PresetFactory.interface.encodeFunctionData('transfer', [owner.address, ethers.parseEther('1')]);
        const amount = 0;

        const dataCallFail = OZERC20PresetFactory.interface.encodeFunctionData('transfer', [owner.address, ethers.parseEther('20000001')]);

        // Cannot fails internal call, contract not deployed
        await expect(fyrechainZKEVMDeployerContract.connect(owner).deployDeterministicAndCall(
            amount,
            salt,
            deployTransactionERC20,
            dataCallFail,
        )).to.be.revertedWith('ERC20: transfer amount exceeds balance');

        // Deploy using create2
        await expect(fyrechainZKEVMDeployerContract.connect(owner).deployDeterministicAndCall(
            amount,
            salt,
            deployTransactionERC20,
            dataCall,
        )).to.emit(fyrechainZKEVMDeployerContract, 'NewDeterministicDeployment').withArgs(precalculateTokenDeployed);

        const instanceToken = OZERC20PresetFactory.attach(precalculateTokenDeployed);
        expect(await instanceToken.balanceOf(owner.address)).to.be.equal(ethers.parseEther('1'));

        // Cannot create 2 times the same contract
        await expect(fyrechainZKEVMDeployerContract.connect(owner).deployDeterministicAndCall(
            amount,
            salt,
            deployTransactionERC20,
            dataCall,
        )).to.be.revertedWith('Create2: Failed on deploy');
    });

    it('Test keyless deployment', async () => {
        const FyrechainZKEVMDeployerFactory = await ethers.getContractFactory(
            'FirechainZkEVMDeployer',
        );

        const deployTxZKEVMDeployer = (FyrechainZKEVMDeployerFactory.getDeployTransaction(
            owner.address,
        )).data;

        const gasLimit = ethers.BigNumber.from(1000000); // Put 1 Million, aprox 650k are necessary
        const gasPrice = ethers.BigNumber.from(ethers.parseUnits('100', 'gwei')); // just in case to be able to use always the transaction
        const to = '0x'; // deployment transaction, to is 0
        const tx = {
            to,
            nonce: 0,
            value: 0,
            gasLimit: gasLimit.toHexString(),
            gasPrice: gasPrice.toHexString(),
            data: deployTxZKEVMDeployer,
        };

        const signature = {
            v: 27,
            r: '0x247000', // Equals 0x0000000000000000000000000000000000000000000000000000000000247000
            s: '0x2470', // Equals 0x0000000000000000000000000000000000000000000000000000000000002470
        };
        const serializedTransaction = ethers.serializeTransaction(tx, signature);
        const resultTransaction = ethers.parseTransaction(serializedTransaction);
        const totalEther = gasLimit.mul(gasPrice); // 0.1 ether

        // Fund keyless deployment
        const params = {
            to: resultTransaction.from,
            value: totalEther.toHexString(),
        };
        const zkEVMDeployerAddress = ethers.getContractAddress(resultTransaction);

        await deployer.sendTransaction(params);
        await ethers.provider.sendTransaction(serializedTransaction);

        const zkEVMDeployerContract = FyrechainZKEVMDeployerFactory.attach(zkEVMDeployerAddress);
        expect(await zkEVMDeployerContract.owner()).to.be.equal(owner.address);
    });
    it('Test Bridge deployment', async () => {
        const bridgeFactory = await ethers.getContractFactory(
            'FirechainZkEVMBridge',
        );

        const salt = ethers.HashZero;

        // Encode deploy transaction
        const deployTransactionBridge = (bridgeFactory.getDeployTransaction()).data;
        const hashInitCode = ethers.solidityPackedKeccak256(['bytes'], [deployTransactionBridge]);

        // Precalculate create2 address
        const precalculateTokenDeployed = await ethers.getCreate2Address(fyrechainZKEVMDeployerContract.address, salt, hashInitCode);
        expect(await fyrechainZKEVMDeployerContract.predictDeterministicAddress(
            salt,
            hashInitCode,
        )).to.be.equal(precalculateTokenDeployed);

        const amount = 0;

        // Deploy using create2
        const populatedTransaction = await fyrechainZKEVMDeployerContract.connect(owner).populateTransaction.deployDeterministic(
            amount,
            salt,
            deployTransactionBridge,
        );

        populatedTransaction.gasLimit = ethers.BigNumber.from(6000000); // Should be more than enough with 5M
        await expect(owner.sendTransaction(populatedTransaction))
            .to.emit(fyrechainZKEVMDeployerContract, 'NewDeterministicDeployment').withArgs(precalculateTokenDeployed);
    });
});
