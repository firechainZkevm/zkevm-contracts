/* eslint-disable no-await-in-loop, no-use-before-define, no-lonely-if */
/* eslint-disable no-console, no-inner-declarations, no-undef, import/no-unresolved */
import {expect} from "chai";
import path = require("path");
import fs = require("fs");

import * as dotenv from "dotenv";
dotenv.config({path: path.resolve(__dirname, "../../.env")});
import {ethers, upgrades} from "hardhat";
import {FirechainZkEVM} from "../../typechain-types";

const pathOutputJson = path.join(__dirname, "./upgrade_output.json");

const deployParameters = require("./deploy_parameters.json");
const deployOutputParameters = require("./deploy_output.json");
const upgradeParameters = require("./upgrade_parameters.json");

async function main() {
    upgrades.silenceWarnings();

    /*
     * Check upgrade parameters
     * Check that every necessary parameter is fullfilled
     */
    const mandatoryUpgradeParameters = ["realVerifier", "newForkID", "timelockDelay", "polTokenAddress"];

    for (const parameterName of mandatoryUpgradeParameters) {
        if (upgradeParameters[parameterName] === undefined || upgradeParameters[parameterName] === "") {
            throw new Error(`Missing parameter: ${parameterName}`);
        }
    }

    const {realVerifier, newForkID, timelockDelay, polTokenAddress} = upgradeParameters;
    const salt = upgradeParameters.timelockSalt || ethers.ZeroHash;

    /*
     * Check output parameters
     * Check that every necessary parameter is fullfilled
     */
    const mandatoryOutputParameters = [
        "firechainZkEVMBridgeAddress",
        "firechainZkEVMGlobalExitRootAddress",
        "firechainZkEVMAddress",
        "timelockContractAddress",
    ];

    for (const parameterName of mandatoryOutputParameters) {
        if (deployOutputParameters[parameterName] === undefined || deployOutputParameters[parameterName] === "") {
            throw new Error(`Missing parameter: ${parameterName}`);
        }
    }

    const currentBridgeAddress = deployOutputParameters.firechainZkEVMBridgeAddress;
    const currentGlobalExitRootAddress = deployOutputParameters.firechainZkEVMGlobalExitRootAddress;
    const currentFirechainZkEVMAddress = deployOutputParameters.firechainZkEVMAddress;
    const currentTimelockAddress = deployOutputParameters.timelockContractAddress;

    // Load onchain parameters
    const firechainZkEVMFactory = await ethers.getContractFactory("FirechainZkEVM");
    const firechainZkEVMContract = (await firechainZkEVMFactory.attach(currentFirechainZkEVMAddress)) as FirechainZkEVM;

    const admin = await firechainZkEVMContract.admin();
    const trustedAggregator = await firechainZkEVMContract.trustedAggregator();
    const trustedAggregatorTimeout = await firechainZkEVMContract.trustedAggregatorTimeout();
    const pendingStateTimeout = await firechainZkEVMContract.pendingStateTimeout();
    const chainID = await firechainZkEVMContract.chainID();
    const emergencyCouncilAddress = await firechainZkEVMContract.owner();

    console.log(
        {admin},
        {trustedAggregator},
        {trustedAggregatorTimeout},
        {pendingStateTimeout},
        {chainID},
        {emergencyCouncilAddress}
    );

    // Load provider
    let currentProvider = ethers.provider;
    if (deployParameters.multiplierGas || deployParameters.maxFeePerGas) {
        if (process.env.HARDHAT_NETWORK !== "hardhat") {
            currentProvider = ethers.getDefaultProvider(
                `https://${process.env.HARDHAT_NETWORK}.infura.io/v3/${process.env.INFURA_PROJECT_ID}`
            ) as any;
            if (deployParameters.maxPriorityFeePerGas && deployParameters.maxFeePerGas) {
                console.log(
                    `Hardcoded gas used: MaxPriority${deployParameters.maxPriorityFeePerGas} gwei, MaxFee${deployParameters.maxFeePerGas} gwei`
                );
                const FEE_DATA = new ethers.FeeData(
                    null,
                    ethers.parseUnits(deployParameters.maxFeePerGas, "gwei"),
                    ethers.parseUnits(deployParameters.maxPriorityFeePerGas, "gwei")
                );

                currentProvider.getFeeData = async () => FEE_DATA;
            } else {
                console.log("Multiplier gas used: ", deployParameters.multiplierGas);
                async function overrideFeeData() {
                    const feedata = await ethers.provider.getFeeData();
                    return new ethers.FeeData(
                        null,
                        ((feedata.maxFeePerGas as bigint) * BigInt(deployParameters.multiplierGas)) / 1000n,
                        ((feedata.maxPriorityFeePerGas as bigint) * BigInt(deployParameters.multiplierGas)) / 1000n
                    );
                }
                currentProvider.getFeeData = overrideFeeData;
            }
        }
    }

    // Load deployer
    let deployer;
    if (deployParameters.deployerPvtKey) {
        deployer = new ethers.Wallet(deployParameters.deployerPvtKey, currentProvider);
    } else if (process.env.MNEMONIC) {
        deployer = ethers.HDNodeWallet.fromMnemonic(
            ethers.Mnemonic.fromPhrase(process.env.MNEMONIC),
            "m/44'/60'/0'/0/0"
        ).connect(currentProvider);
    } else {
        [deployer] = await ethers.getSigners();
    }

    console.log("deploying with: ", deployer.address);

    const proxyAdmin = await upgrades.admin.getInstance();

    // Assert correct admin
    expect(await upgrades.erc1967.getAdminAddress(currentFirechainZkEVMAddress as string)).to.be.equal(proxyAdmin.target);

    // deploy new verifier
    let verifierContract;
    if (realVerifier === true) {
        const VerifierRollup = await ethers.getContractFactory("FflonkVerifier", deployer);
        verifierContract = await VerifierRollup.deploy();
        await verifierContract.waitForDeployment();
    } else {
        const VerifierRollupHelperFactory = await ethers.getContractFactory("VerifierRollupHelperMock", deployer);
        verifierContract = await VerifierRollupHelperFactory.deploy();
        await verifierContract.waitForDeployment();
    }
    console.log("#######################\n");
    console.log("Verifier deployed to:", verifierContract.target);
    console.log(`npx hardhat verify ${verifierContract.target} --network ${process.env.HARDHAT_NETWORK}`);

    // load timelock
    const timelockContractFactory = await ethers.getContractFactory("FirechainZkEVMTimelock", deployer);

    // prapare upgrades

    // Prepare Upgrade FirechainZkEVMBridge
    const firechainZkEVMBridgeFactory = await ethers.getContractFactory("FirechainZkEVMBridgeV2", deployer);

    const newBridgeImpl = await upgrades.prepareUpgrade(currentBridgeAddress, firechainZkEVMBridgeFactory, {
        unsafeAllow: ["constructor"],
    });

    console.log("#######################\n");
    console.log(`FirechainZkEVMBridge impl: ${newBridgeImpl}`);

    console.log("you can verify the new impl address with:");
    console.log(`npx hardhat verify ${newBridgeImpl} --network ${process.env.HARDHAT_NETWORK}`);

    const operationBridge = genOperation(
        proxyAdmin.target,
        0, // value
        proxyAdmin.interface.encodeFunctionData("upgrade", [currentBridgeAddress, newBridgeImpl]),
        ethers.ZeroHash, // predecesoor
        salt // salt
    );

    // prepare upgrade global exit root
    // Prepare Upgrade  FirechainZkEVMGlobalExitRootV2
    const firechainGlobalExitRootV2 = await ethers.getContractFactory("FirechainZkEVMGlobalExitRootV2", deployer);

    const newGlobalExitRoortImpl = await upgrades.prepareUpgrade(
        currentGlobalExitRootAddress,
        firechainGlobalExitRootV2,
        {
            constructorArgs: [currentFirechainZkEVMAddress, currentBridgeAddress],
            unsafeAllow: ["constructor", "state-variable-immutable"],
        }
    );

    console.log("#######################\n");
    console.log(`firechainGlobalExitRootV2 impl: ${newGlobalExitRoortImpl}`);

    console.log("you can verify the new impl address with:");
    console.log(
        `npx hardhat verify --constructor-args upgrade/arguments.js ${newGlobalExitRoortImpl} --network ${process.env.HARDHAT_NETWORK}\n`
    );
    console.log("Copy the following constructor arguments on: upgrade/arguments.js \n", [
        currentFirechainZkEVMAddress,
        currentBridgeAddress,
    ]);

    const operationGlobalExitRoot = genOperation(
        proxyAdmin.target,
        0, // value
        proxyAdmin.interface.encodeFunctionData("upgrade", [currentGlobalExitRootAddress, newGlobalExitRoortImpl]),
        ethers.ZeroHash, // predecesoor
        salt // salt
    );

    // Update current system to rollup manager

    // deploy firechain zkEVM impl
    const FirechainZkEVMV2ExistentFactory = await ethers.getContractFactory("FirechainZkEVMExistentEtrog");
    const firechainZkEVMEtrogImpl = await FirechainZkEVMV2ExistentFactory.deploy(
        currentGlobalExitRootAddress,
        polTokenAddress,
        currentBridgeAddress,
        currentFirechainZkEVMAddress
    );
    await firechainZkEVMEtrogImpl.waitForDeployment();

    console.log("#######################\n");
    console.log(`new FirechainZkEVM impl: ${firechainZkEVMEtrogImpl.target}`);

    console.log("you can verify the new impl address with:");
    console.log(
        `npx hardhat verify --constructor-args upgrade/arguments.js ${firechainZkEVMEtrogImpl.target} --network ${process.env.HARDHAT_NETWORK}\n`
    );
    console.log("Copy the following constructor arguments on: upgrade/arguments.js \n", [
        currentGlobalExitRootAddress,
        polTokenAddress,
        currentBridgeAddress,
        currentFirechainZkEVMAddress,
    ]);

    // deploy firechain zkEVM proxy
    const FirechainTransparentProxy = await ethers.getContractFactory("FirechainTransparentProxy");
    const newFirechainZkEVMContract = await FirechainTransparentProxy.deploy(
        firechainZkEVMEtrogImpl.target,
        currentFirechainZkEVMAddress,
        "0x"
    );
    await newFirechainZkEVMContract.waitForDeployment();
    console.log("#######################\n");
    console.log(`new FirechainZkEVM Proxy: ${newFirechainZkEVMContract.target}`);

    console.log("you can verify the new impl address with:");
    console.log(
        `npx hardhat verify --constructor-args upgrade/arguments.js ${newFirechainZkEVMContract.target} --network ${process.env.HARDHAT_NETWORK}\n`
    );
    console.log("Copy the following constructor arguments on: upgrade/arguments.js \n", [
        firechainZkEVMEtrogImpl.target,
        currentFirechainZkEVMAddress,
        "0x",
    ]);

    // Upgrade to rollup manager previous firechainZKEVM
    const FirechainRollupManagerFactory = await ethers.getContractFactory("FirechainRollupManager");
    const implRollupManager = await upgrades.prepareUpgrade(currentFirechainZkEVMAddress, FirechainRollupManagerFactory, {
        constructorArgs: [currentGlobalExitRootAddress, polTokenAddress, currentBridgeAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
    });

    console.log("#######################\n");
    console.log(`Firechain rollup manager: ${implRollupManager}`);

    console.log("you can verify the new impl address with:");
    console.log(
        `npx hardhat verify --constructor-args upgrade/arguments.js ${implRollupManager} --network ${process.env.HARDHAT_NETWORK}\n`
    );
    console.log("Copy the following constructor arguments on: upgrade/arguments.js \n", [
        currentGlobalExitRootAddress,
        polTokenAddress,
        currentBridgeAddress,
    ]);

    const operationRollupManager = genOperation(
        proxyAdmin.target,
        0, // value
        proxyAdmin.interface.encodeFunctionData("upgradeAndCall", [
            currentFirechainZkEVMAddress,
            implRollupManager,
            FirechainRollupManagerFactory.interface.encodeFunctionData("initialize", [
                trustedAggregator,
                pendingStateTimeout,
                trustedAggregatorTimeout,
                admin,
                currentTimelockAddress,
                emergencyCouncilAddress,
                newFirechainZkEVMContract.target,
                verifierContract.target,
                newForkID,
                chainID,
            ]),
        ]),
        ethers.ZeroHash, // predecesoor
        salt // salt
    );

    // Schedule operation
    const scheduleData = timelockContractFactory.interface.encodeFunctionData("scheduleBatch", [
        [operationGlobalExitRoot.target, operationBridge.target, operationRollupManager.target],
        [operationGlobalExitRoot.value, operationBridge.value, operationRollupManager.value],
        [operationGlobalExitRoot.data, operationBridge.data, operationRollupManager.data],
        ethers.ZeroHash, // predecesoor
        salt, // salt
        timelockDelay,
    ]);

    // Execute operation
    const executeData = timelockContractFactory.interface.encodeFunctionData("executeBatch", [
        [operationGlobalExitRoot.target, operationBridge.target, operationRollupManager.target],
        [operationGlobalExitRoot.value, operationBridge.value, operationRollupManager.value],
        [operationGlobalExitRoot.data, operationBridge.data, operationRollupManager.data],
        ethers.ZeroHash, // predecesoor
        salt, // salt
    ]);

    console.log({scheduleData});
    console.log({executeData});

    const outputJson = {
        scheduleData,
        executeData,
        verifierAddress: verifierContract.target,
        newFirechainZKEVM: newFirechainZkEVMContract.target,
        timelockContractAdress: currentTimelockAddress,
    };
    fs.writeFileSync(pathOutputJson, JSON.stringify(outputJson, null, 1));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

// OZ test functions
function genOperation(target: any, value: any, data: any, predecessor: any, salt: any) {
    const abiEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes", "uint256", "bytes32"],
        [target, value, data, predecessor, salt]
    );
    const id = ethers.keccak256(abiEncoded);
    return {
        id,
        target,
        value,
        data,
        predecessor,
        salt,
    };
}
