const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
process.env.HARDHAT_NETWORK = "hardhat";
const { ethers } = require("hardhat");
const { expect } = require('chai');

const deployMainnet = require("./mainnetDeployment.json");
const mainnetDeployParameters = require("./mainnetDeployParameters.json");

const pathFflonkVerifier = '../artifacts/contracts/verifiers/FflonkVerifier.sol/FflonkVerifier.json';
const pathFirechainZkEVMDeployer = '../artifacts/contracts/deployment/FirechainZkEVMDeployer.sol/FirechainZkEVMDeployer.json';
const pathFirechainZkEVMBridge = '../artifacts/contracts/FirechainZkEVMBridge.sol/FirechainZkEVMBridge.json';
const pathTransparentProxyOZUpgradeDep = '../node_modules/@openzeppelin/upgrades-core/artifacts/@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json';
const pathProxyAdmin = '../artifacts/@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol/ProxyAdmin.json';
const pathTransparentProxy = '../artifacts/@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json';
const pathFirechainZkEVMTimelock = '../artifacts/contracts/FirechainZkEVMTimelock.sol/FirechainZkEVMTimelock.json';
const pathFirechainZkEVM = '../artifacts/contracts/FirechainZkEVM.sol/FirechainZkEVM.json';
const pathFirechainZkEVMGlobalExitRoot = '../artifacts/contracts/FirechainZkEVMGlobalExitRoot.sol/FirechainZkEVMGlobalExitRoot.json';

const FflonkVerifier = require(pathFflonkVerifier);
const FirechainZkEVMDeployer = require(pathFirechainZkEVMDeployer);
const FirechainZkEVMBridge = require(pathFirechainZkEVMBridge);
const TransparentProxyOZUpgradeDep = require(pathTransparentProxyOZUpgradeDep);
const ProxyAdmin = require(pathProxyAdmin);
const TransparentProxy = require(pathTransparentProxy);


const etherscanURL = "https://etherscan.io/address/"
async function main() {
    // First verify not immutable conracts
    const mainnetProvider = new ethers.providers.JsonRpcProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`);

    // FflonkVerifier
    expect(await mainnetProvider.getCode(deployMainnet.fflonkVerifierAddress))
        .to.be.equal(FflonkVerifier.deployedBytecode);
    console.log("FflonkVerifier was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + deployMainnet.fflonkVerifierAddress)
    console.log("Path file: ", path.join(__dirname, pathFflonkVerifier));
    console.log();

    // FirechainZkEVMDeployer
    expect(await mainnetProvider.getCode(deployMainnet.firechainZkEVMDeployerAddress))
        .to.be.equal(FirechainZkEVMDeployer.deployedBytecode);
    console.log("FirechainZkEVMDeployer was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + deployMainnet.firechainZkEVMDeployerAddress)
    console.log("Path file: ", path.join(__dirname, pathFirechainZkEVMDeployer));
    console.log();

    // Bridge
    // Since this contract is a proxy, we will need to verify the implementation
    const firechainZkEVMBridgeImpl = await getImplementationAddress(deployMainnet.firechainZkEVMBridgeAddress, mainnetProvider)

    expect(await mainnetProvider.getCode(firechainZkEVMBridgeImpl))
        .to.be.equal(FirechainZkEVMBridge.deployedBytecode);
    console.log("FirechainZkEVMBridgeAddress implementation was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + firechainZkEVMBridgeImpl)
    console.log("Path file: ", path.join(__dirname, pathFirechainZkEVMBridge));
    console.log();

    // Check transparent Proxys
    expect(await mainnetProvider.getCode(deployMainnet.firechainZkEVMBridgeAddress))
        .to.be.equal(TransparentProxy.deployedBytecode);
    console.log("FirechainZkEVMBridgeAddress proxy was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + deployMainnet.firechainZkEVMBridgeAddress);
    console.log("Path file: ", path.join(__dirname, pathTransparentProxy));
    console.log();

    // The other 3 contracts are immutables, therefore we will deploy them locally and check the btyecode against the deployed one

    // FirechainZkEVMTimelock
    const FirechainZkEVMTimelockFactory = await ethers.getContractFactory('FirechainZkEVMTimelock');
    const timelockAddress = mainnetDeployParameters.timelockAddress; //not relevant to deployed bytecode
    const minDelayTimelock = mainnetDeployParameters.minDelayTimelock; //not relevant to deployed bytecode

    const FirechainZkEVMTimelock = await FirechainZkEVMTimelockFactory.deploy(
        minDelayTimelock,
        [timelockAddress],
        [timelockAddress],
        timelockAddress,
        deployMainnet.firechainZkEVMAddress,
    );
    FirechainZkEVMTimelock.deployed()

    const deployedBytecodeFirechainZkEVMTimelock = await ethers.provider.getCode(FirechainZkEVMTimelock.address);
    expect(await mainnetProvider.getCode(deployMainnet.firechainZkEVMTimelockAddress))
        .to.be.equal(deployedBytecodeFirechainZkEVMTimelock);
    console.log("Timelock was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + deployMainnet.firechainZkEVMTimelockAddress);
    console.log("Path file: ", path.join(__dirname, pathFirechainZkEVMTimelock));
    console.log();

    // firechainZkEVMGlobalExitRoot
    const FirechainZkEVMGlobalExitRootFactory = await ethers.getContractFactory('FirechainZkEVMGlobalExitRoot');
    const firechainZkEVMGlobalExitRoot = await FirechainZkEVMGlobalExitRootFactory.deploy(
        deployMainnet.firechainZkEVMAddress,
        deployMainnet.firechainZkEVMBridgeAddress
    );
    firechainZkEVMGlobalExitRoot.deployed()

    const deployedBytecodeGlobalExitRoot = await ethers.provider.getCode(firechainZkEVMGlobalExitRoot.address);
    const firechainZkEVMGlobalImpl = await getImplementationAddress(deployMainnet.firechainZkEVMGlobalExitRootAddress, mainnetProvider)

    expect(await mainnetProvider.getCode(firechainZkEVMGlobalImpl))
        .to.be.equal(deployedBytecodeGlobalExitRoot);
    console.log("FirechainZkEVMGlobalExitRoot implementation was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + firechainZkEVMGlobalImpl);
    console.log("Path file: ", path.join(__dirname, pathFirechainZkEVMGlobalExitRoot));
    console.log();

    // Check transparent Proxys
    expect(await mainnetProvider.getCode(deployMainnet.firechainZkEVMGlobalExitRootAddress))
        .to.be.equal(TransparentProxyOZUpgradeDep.deployedBytecode);
    console.log("FirechainZkEVMGlobalExitRoot proxy was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + deployMainnet.firechainZkEVMGlobalExitRootAddress);
    console.log("Path file: ", path.join(__dirname, pathTransparentProxyOZUpgradeDep));
    console.log();

    // FirechainZkEVM
    const mainnetChainID = mainnetDeployParameters.chainID;
    const mainnetForkID = mainnetDeployParameters.forkID;
    const maticAddress = mainnetDeployParameters.maticTokenAddress;

    const FirechainZkEVMFactory = await ethers.getContractFactory('FirechainZkEVM');
    const firechainZkEVMContract = await FirechainZkEVMFactory.deploy(
        deployMainnet.firechainZkEVMGlobalExitRootAddress,
        maticAddress,
        deployMainnet.fflonkVerifierAddress,
        deployMainnet.firechainZkEVMBridgeAddress,
        mainnetChainID,
        mainnetForkID,
    );
    firechainZkEVMContract.deployed()

    const deployedBytecodeFirechainZkEVM = await ethers.provider.getCode(firechainZkEVMContract.address);
    const firechainZkEVMImpl = await getImplementationAddress(deployMainnet.firechainZkEVMAddress, mainnetProvider)

    expect(await mainnetProvider.getCode(firechainZkEVMImpl))
        .to.be.equal(deployedBytecodeFirechainZkEVM);
    console.log("FirechainZkEVMAddress implementation was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + firechainZkEVMImpl);
    console.log("Path file: ", path.join(__dirname, pathFirechainZkEVM));
    console.log();

    // Check transparent Proxys
    expect(await mainnetProvider.getCode(deployMainnet.firechainZkEVMAddress))
        .to.be.equal(TransparentProxyOZUpgradeDep.deployedBytecode);
    console.log("FirechainZkEVMAddress proxy was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + deployMainnet.firechainZkEVMAddress);
    console.log("Path file: ", path.join(__dirname, pathTransparentProxyOZUpgradeDep));
    console.log();

    // Check proxy Admin
    const firechainZkEVMBridgeAdmin = await getProxyAdminAddress(deployMainnet.firechainZkEVMBridgeAddress, mainnetProvider);
    const firechainZkEVMAdmin = await getProxyAdminAddress(deployMainnet.firechainZkEVMAddress, mainnetProvider);
    const firechainZkEVMGlobalExitRootAdmin = await getProxyAdminAddress(deployMainnet.firechainZkEVMGlobalExitRootAddress, mainnetProvider);

    expect(firechainZkEVMBridgeAdmin).to.be.equal(firechainZkEVMAdmin);
    expect(firechainZkEVMAdmin).to.be.equal(firechainZkEVMGlobalExitRootAdmin);
    expect(await mainnetProvider.getCode(firechainZkEVMAdmin))
        .to.be.equal(ProxyAdmin.deployedBytecode);
    console.log("ProxyAdmin proxy was correctly verified")
    console.log("Etherscan URL: ", etherscanURL + firechainZkEVMAdmin);
    console.log("Path file: ", path.join(__dirname, pathProxyAdmin));
    console.log();

    // Assert genesis is the same as the provided in the document
    let mainnetFirechainZkVEM = (await ethers.getContractFactory('FirechainZkEVM', mainnetProvider)).attach(deployMainnet.firechainZkEVMAddress);
    mainnetFirechainZkVEM = mainnetFirechainZkVEM.connect(mainnetProvider);
    expect(await mainnetFirechainZkVEM.batchNumToStateRoot(0)).to.be.equal(deployMainnet.genesisRoot);
    console.log("Genesis root was correctly verified:", deployMainnet.genesisRoot)

}
// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

//     bytes32 internal constant _ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
//     bytes32 internal constant _IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function getImplementationAddress(proxyAddress, provider) {
    const implementationAddress = await provider.getStorageAt(proxyAddress, implSlot);
    return `0x${implementationAddress.slice(2 + (32 * 2 - 40))}`
}

async function getProxyAdminAddress(proxyAddress, provider) {
    const adminAddress = await provider.getStorageAt(proxyAddress, adminSlot);
    return `0x${adminAddress.slice(2 + (32 * 2 - 40))}`
}
