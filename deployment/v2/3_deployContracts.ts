/* eslint-disable no-await-in-loop, no-use-before-define, no-lonely-if */
/* eslint-disable no-console, no-inner-declarations, no-undef, import/no-unresolved */
import {expect} from "chai";
import path = require("path");
import fs = require("fs");

import * as dotenv from "dotenv";
dotenv.config({path: path.resolve(__dirname, "../../.env")});
import {ethers, upgrades} from "hardhat";

const {create2Deployment} = require("../helpers/deployment-helpers");

const pathOutputJson = path.join(__dirname, "./deploy_output.json");
const pathOngoingDeploymentJson = path.join(__dirname, "./deploy_ongoing.json");

const deployParameters = require("./deploy_parameters.json");

const pathOZUpgradability = path.join(__dirname, `../../.openzeppelin/${process.env.HARDHAT_NETWORK}.json`);

import {
    FirechainZkEVMBridgeV2,
    FirechainZkEVMDeployer,
    FirechainZkEVMGlobalExitRootV2,
    FirechainZkEVMTimelock,
    ProxyAdmin,
} from "../../typechain-types";
import "../helpers/utils";

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const ADD_ROLLUP_TYPE_ROLE = ethers.id("ADD_ROLLUP_TYPE_ROLE");
const OBSOLETE_ROLLUP_TYPE_ROLE = ethers.id("OBSOLETE_ROLLUP_TYPE_ROLE");
const CREATE_ROLLUP_ROLE = ethers.id("CREATE_ROLLUP_ROLE");
const ADD_EXISTING_ROLLUP_ROLE = ethers.id("ADD_EXISTING_ROLLUP_ROLE");
const UPDATE_ROLLUP_ROLE = ethers.id("UPDATE_ROLLUP_ROLE");
const TRUSTED_AGGREGATOR_ROLE = ethers.id("TRUSTED_AGGREGATOR_ROLE");
const TRUSTED_AGGREGATOR_ROLE_ADMIN = ethers.id("TRUSTED_AGGREGATOR_ROLE_ADMIN");
const TWEAK_PARAMETERS_ROLE = ethers.id("TWEAK_PARAMETERS_ROLE");
const SET_FEE_ROLE = ethers.id("SET_FEE_ROLE");
const STOP_EMERGENCY_ROLE = ethers.id("STOP_EMERGENCY_ROLE");
const EMERGENCY_COUNCIL_ROLE = ethers.id("EMERGENCY_COUNCIL_ROLE");
const EMERGENCY_COUNCIL_ADMIN = ethers.id("EMERGENCY_COUNCIL_ADMIN");

async function main() {
    // Check that there's no previous OZ deployment
    if (fs.existsSync(pathOZUpgradability)) {
        throw new Error(
            `There's upgradability information from previous deployments, it's mandatory to erase them before start a new one, path: ${pathOZUpgradability}`
        );
    }

    // Check if there's an ongoing deployment
    let ongoingDeployment = {} as any;
    if (fs.existsSync(pathOngoingDeploymentJson)) {
        console.log("WARNING: using ongoing deployment");
        ongoingDeployment = require(pathOngoingDeploymentJson);
    }

    // Constant variables
    const networkIDMainnet = 0;

    // Gas token variables are 0 in mainnet, since native token it's ether
    const gasTokenAddressMainnet = ethers.ZeroAddress;
    const gasTokenNetworkMainnet = 0n;
    const attemptsDeployProxy = 20;
    const gasTokenMetadata = "0x";

    /*
     * Check deploy parameters
     * Check that every necessary parameter is fullfilled
     */
    const mandatoryDeploymentParameters = [
        "timelockAdminAddress",
        "minDelayTimelock",
        "salt",
        "admin",
        "trustedAggregator",
        "trustedAggregatorTimeout",
        "pendingStateTimeout",
        "emergencyCouncilAddress",
        "zkEVMDeployerAddress",
        "polTokenAddress",
    ];

    for (const parameterName of mandatoryDeploymentParameters) {
        if (deployParameters[parameterName] === undefined || deployParameters[parameterName] === "") {
            throw new Error(`Missing parameter: ${parameterName}`);
        }
    }

    const {
        admin,
        trustedAggregator,
        trustedAggregatorTimeout,
        pendingStateTimeout,
        emergencyCouncilAddress,
        timelockAdminAddress,
        minDelayTimelock,
        salt,
        zkEVMDeployerAddress,
        polTokenAddress,
    } = deployParameters;

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

    // Load zkEVM deployer
    const FyrechainZKEVMDeployerFactory = await ethers.getContractFactory("FirechainZkEVMDeployer", deployer);
    const zkEVMDeployerContract = FyrechainZKEVMDeployerFactory.attach(zkEVMDeployerAddress) as FirechainZkEVMDeployer;

    // check deployer is the owner of the deployer
    if ((await deployer.provider?.getCode(zkEVMDeployerContract.target)) === "0x") {
        throw new Error("zkEVM deployer contract is not deployed");
    }
    expect(deployer.address).to.be.equal(await zkEVMDeployerContract.owner());

    /*
     * Deploy Bridge
     * Deploy admin --> implementation --> proxy
     */

    // Deploy proxy admin:
    const proxyAdminFactory = await ethers.getContractFactory(
        "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
        deployer
    );
    const deployTransactionAdmin = (await proxyAdminFactory.getDeployTransaction()).data;
    const dataCallAdmin = proxyAdminFactory.interface.encodeFunctionData("transferOwnership", [deployer.address]);
    const [proxyAdminAddress, isProxyAdminDeployed] = await create2Deployment(
        zkEVMDeployerContract,
        salt,
        deployTransactionAdmin,
        dataCallAdmin,
        deployer
    );

    if (isProxyAdminDeployed) {
        console.log("#######################\n");
        console.log("Proxy admin deployed to:", proxyAdminAddress);
    } else {
        console.log("#######################\n");
        console.log("Proxy admin was already deployed to:", proxyAdminAddress);
    }

    const proxyAdminInstance = proxyAdminFactory.attach(proxyAdminAddress) as ProxyAdmin;
    const proxyAdminOwner = await proxyAdminInstance.owner();
    if (proxyAdminOwner !== deployer.address) {
        throw new Error(
            `Proxy admin was deployed, but the owner is not the deployer, deployer address: ${deployer.address}, proxyAdmin: ${proxyAdminOwner}`
        );
    }

    // Deploy implementation FirechainZkEVMBridge
    const firechainZkEVMBridgeFactory = await ethers.getContractFactory("FirechainZkEVMBridgeV2", deployer);
    const deployTransactionBridge = (await firechainZkEVMBridgeFactory.getDeployTransaction()).data;
    const dataCallNull = null;
    // Mandatory to override the gasLimit since the estimation with create are mess up D:
    const overrideGasLimit = 5500000n;
    const [bridgeImplementationAddress, isBridgeImplDeployed] = await create2Deployment(
        zkEVMDeployerContract,
        salt,
        deployTransactionBridge,
        dataCallNull,
        deployer,
        overrideGasLimit
    );

    if (isBridgeImplDeployed) {
        console.log("#######################\n");
        console.log("bridge impl deployed to:", bridgeImplementationAddress);
    } else {
        console.log("#######################\n");
        console.log("bridge impl was already deployed to:", bridgeImplementationAddress);
    }

    let precalculateGlobalExitRootAddress;
    let precalculateRollupManager;
    let timelockContract;

    const timelockContractFactory = await ethers.getContractFactory("FirechainZkEVMTimelock", deployer);

    // Check if the contract is already deployed
    if (
        ongoingDeployment.firechainZkEVMGlobalExitRoot &&
        ongoingDeployment.firechainRollupManagerContract &&
        ongoingDeployment.firechainTimelock
    ) {
        precalculateGlobalExitRootAddress = ongoingDeployment.firechainZkEVMGlobalExitRoot;
        precalculateRollupManager = ongoingDeployment.firechainRollupManagerContract;
        timelockContract = timelockContractFactory.attach(ongoingDeployment.firechainTimelock) as FirechainZkEVMTimelock;
    } else {
        // If both are not deployed, it's better to deploy them both again
        delete ongoingDeployment.firechainZkEVMGlobalExitRoot;
        delete ongoingDeployment.firechainRollupManagerContract;
        fs.writeFileSync(pathOngoingDeploymentJson, JSON.stringify(ongoingDeployment, null, 1));

        // Nonce globalExitRoot: currentNonce + 1 (deploy bridge proxy) + 1(impl globalExitRoot)
        // + 1 (deployTimelock) + 1 (transfer Ownership Admin) = +4
        const nonceProxyGlobalExitRoot = Number(await ethers.provider.getTransactionCount(deployer.address)) + 4;
        // nonceProxyRollupManager :Nonce globalExitRoot + 1 (proxy globalExitRoot) + 1 (impl rollupManager) = +2
        const nonceProxyRollupManager = nonceProxyGlobalExitRoot + 2;

        // Contracts are not deployed, normal deployment
        precalculateGlobalExitRootAddress = ethers.getCreateAddress({
            from: deployer.address,
            nonce: nonceProxyGlobalExitRoot,
        });
        precalculateRollupManager = ethers.getCreateAddress({from: deployer.address, nonce: nonceProxyRollupManager});

        // deploy timelock
        console.log("\n#######################");
        console.log("##### Deployment TimelockContract  #####");
        console.log("#######################");
        console.log("minDelayTimelock:", minDelayTimelock);
        console.log("timelockAdminAddress:", timelockAdminAddress);
        console.log("Rollup Manager:", precalculateRollupManager);
        timelockContract = await timelockContractFactory.deploy(
            minDelayTimelock,
            [timelockAdminAddress],
            [timelockAdminAddress],
            timelockAdminAddress,
            precalculateRollupManager
        );
        await timelockContract.waitForDeployment();
        console.log("#######################\n");
        console.log("Firechain timelockContract deployed to:", timelockContract.target);
    }
    // Transfer ownership of the proxyAdmin to timelock
    await (await proxyAdminInstance.transferOwnership(timelockContract.target)).wait();

    console.log("\n#######################");
    console.log("#####  Checks TimelockContract  #####");
    console.log("#######################");
    //console.log("minDelayTimelock:", await timelockContract.getMinDelay());
    console.log("firechainZkEVM (Rollup Manager):", await timelockContract.firechainZkEVM());

    /*
     * deploy proxy
     * Do not initialize directly the proxy since we want to deploy the same code on L2 and this will alter the bytecode deployed of the proxy
     */
    const transparentProxyFactory = await ethers.getContractFactory(
        "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
        deployer
    );
    const initializeEmptyDataProxy = "0x";
    const deployTransactionProxy = (
        await transparentProxyFactory.getDeployTransaction(
            bridgeImplementationAddress,
            proxyAdminAddress,
            initializeEmptyDataProxy
        )
    ).data;

    const dataCallProxy = firechainZkEVMBridgeFactory.interface.encodeFunctionData("initialize", [
        networkIDMainnet,
        gasTokenAddressMainnet,
        gasTokenNetworkMainnet,
        precalculateGlobalExitRootAddress,
        precalculateRollupManager,
        gasTokenMetadata,
    ]);

    const [proxyBridgeAddress, isBridgeProxyDeployed] = await create2Deployment(
        zkEVMDeployerContract,
        salt,
        deployTransactionProxy,
        dataCallProxy,
        deployer
    );
    const firechainZkEVMBridgeContract = firechainZkEVMBridgeFactory.attach(proxyBridgeAddress) as FirechainZkEVMBridgeV2;

    if (isBridgeProxyDeployed) {
        console.log("#######################\n");
        console.log("FirechainZkEVMBridge deployed to:", firechainZkEVMBridgeContract.target);
    } else {
        console.log("#######################\n");
        console.log("FirechainZkEVMBridge was already deployed to:", firechainZkEVMBridgeContract.target);

        // If it was already deployed, check that the initialized calldata matches the actual deployment
        expect(precalculateGlobalExitRootAddress).to.be.equal(await firechainZkEVMBridgeContract.globalExitRootManager());
        expect(precalculateRollupManager).to.be.equal(await firechainZkEVMBridgeContract.firechainRollupManager());
    }

    console.log("\n#######################");
    console.log("#####    Checks FirechainZkEVMBridge   #####");
    console.log("#######################");
    console.log("FirechainZkEVMGlobalExitRootAddress:", await firechainZkEVMBridgeContract.globalExitRootManager());
    console.log("networkID:", await firechainZkEVMBridgeContract.networkID());
    console.log("Rollup Manager:", await firechainZkEVMBridgeContract.firechainRollupManager());

    // Import OZ manifest the deployed contracts, its enough to import just the proxy, the rest are imported automatically (admin/impl)
    await upgrades.forceImport(proxyBridgeAddress, firechainZkEVMBridgeFactory, "transparent" as any);

    /*
     *Deployment Global exit root manager
     */
    let firechainZkEVMGlobalExitRoot;
    const FirechainZkEVMGlobalExitRootFactory = await ethers.getContractFactory("FirechainZkEVMGlobalExitRootV2", deployer);
    if (!ongoingDeployment.firechainZkEVMGlobalExitRoot) {
        for (let i = 0; i < attemptsDeployProxy; i++) {
            try {
                firechainZkEVMGlobalExitRoot = await upgrades.deployProxy(FirechainZkEVMGlobalExitRootFactory, [], {
                    initializer: false,
                    constructorArgs: [precalculateRollupManager, proxyBridgeAddress],
                    unsafeAllow: ["constructor", "state-variable-immutable"],
                });
                break;
            } catch (error: any) {
                console.log(`attempt ${i}`);
                console.log("upgrades.deployProxy of firechainZkEVMGlobalExitRoot ", error.message);
            }

            // reach limits of attempts
            if (i + 1 === attemptsDeployProxy) {
                throw new Error("firechainZkEVMGlobalExitRoot contract has not been deployed");
            }
        }

        expect(precalculateGlobalExitRootAddress).to.be.equal(firechainZkEVMGlobalExitRoot?.target);

        console.log("#######################\n");
        console.log("firechainZkEVMGlobalExitRoot deployed to:", firechainZkEVMGlobalExitRoot?.target);

        // save an ongoing deployment
        ongoingDeployment.firechainZkEVMGlobalExitRoot = firechainZkEVMGlobalExitRoot?.target;
        fs.writeFileSync(pathOngoingDeploymentJson, JSON.stringify(ongoingDeployment, null, 1));
    } else {
        // sanity check
        expect(precalculateGlobalExitRootAddress).to.be.equal(ongoingDeployment.firechainZkEVMGlobalExitRoot);

        // Expect the precalculate address matches de onogin deployment
        firechainZkEVMGlobalExitRoot = FirechainZkEVMGlobalExitRootFactory.attach(
            ongoingDeployment.firechainZkEVMGlobalExitRoot
        ) as FirechainZkEVMGlobalExitRootV2;

        console.log("#######################\n");
        console.log("firechainZkEVMGlobalExitRoot already deployed on: ", ongoingDeployment.firechainZkEVMGlobalExitRoot);

        // Import OZ manifest the deployed contracts, its enough to import just the proyx, the rest are imported automatically (admin/impl)
        await upgrades.forceImport(
            ongoingDeployment.firechainZkEVMGlobalExitRoot,
            FirechainZkEVMGlobalExitRootFactory,
            "transparent" as any
        );

        // Check against current deployment
        expect(firechainZkEVMBridgeContract.target).to.be.equal(await firechainZkEVMGlobalExitRoot.bridgeAddress());
        expect(precalculateRollupManager).to.be.equal(await firechainZkEVMGlobalExitRoot.rollupManager());
    }

    const timelockAddressRollupManager = deployParameters.test ? deployer.address : timelockContract.target;

    // deploy Rollup Manager
    console.log("\n#######################");
    console.log("##### Deployment Rollup Manager #####");
    console.log("#######################");
    console.log("deployer:", deployer.address);
    console.log("FirechainZkEVMGlobalExitRootAddress:", firechainZkEVMGlobalExitRoot?.target);
    console.log("polTokenAddress:", polTokenAddress);
    console.log("firechainZkEVMBridgeContract:", firechainZkEVMBridgeContract.target);

    console.log("trustedAggregator:", trustedAggregator);
    console.log("pendingStateTimeout:", pendingStateTimeout);
    console.log("trustedAggregatorTimeout:", trustedAggregatorTimeout);
    console.log("admin:", admin);
    console.log("timelockContract:", timelockAddressRollupManager);
    console.log("emergencyCouncilAddress:", emergencyCouncilAddress);

    const FirechainRollupManagerFactory = await ethers.getContractFactory("FirechainRollupManagerNotUpgraded", deployer);

    let firechainRollupManagerContract: any;
    let deploymentBlockNumber;
    if (!ongoingDeployment.firechainRollupManagerContract) {
        for (let i = 0; i < attemptsDeployProxy; i++) {
            try {
                firechainRollupManagerContract = await upgrades.deployProxy(
                    FirechainRollupManagerFactory,
                    [
                        trustedAggregator,
                        pendingStateTimeout,
                        trustedAggregatorTimeout,
                        admin,
                        timelockAddressRollupManager,
                        emergencyCouncilAddress,
                        ethers.ZeroAddress, // unused parameter
                        ethers.ZeroAddress, // unused parameter
                        0, // unused parameter
                        0, // unused parameter
                    ],
                    {
                        initializer: "initialize",
                        constructorArgs: [
                            firechainZkEVMGlobalExitRoot?.target,
                            polTokenAddress,
                            firechainZkEVMBridgeContract.target,
                        ],
                        unsafeAllow: ["constructor", "state-variable-immutable"],
                    }
                );

                break;
            } catch (error: any) {
                console.log(`attempt ${i}`);
                console.log("upgrades.deployProxy of firechainRollupManagerContract ", error.message);
            }

            // reach limits of attempts
            if (i + 1 === attemptsDeployProxy) {
                throw new Error("Rollup Manager contract has not been deployed");
            }
        }

        expect(precalculateRollupManager).to.be.equal(firechainRollupManagerContract?.target);

        console.log("#######################\n");
        console.log("firechainRollupManagerContract deployed to:", firechainRollupManagerContract?.target);

        // save an ongoing deployment
        ongoingDeployment.firechainRollupManagerContract = firechainRollupManagerContract?.target;
        fs.writeFileSync(pathOngoingDeploymentJson, JSON.stringify(ongoingDeployment, null, 1));
        deploymentBlockNumber = (await firechainRollupManagerContract?.deploymentTransaction().wait()).blockNumber;
    } else {
        // Expect the precalculate address matches de onogin deployment, sanity check
        expect(precalculateRollupManager).to.be.equal(ongoingDeployment.firechainRollupManagerContract);
        firechainRollupManagerContract = FirechainRollupManagerFactory.attach(
            ongoingDeployment.firechainRollupManagerContract
        );

        console.log("#######################\n");
        console.log(
            "firechainRollupManagerContract already deployed on: ",
            ongoingDeployment.firechainRollupManagerContract
        );

        // Import OZ manifest the deployed contracts, its enough to import just the proyx, the rest are imported automatically ( admin/impl)
        await upgrades.forceImport(
            ongoingDeployment.firechainRollupManagerContract,
            FirechainRollupManagerFactory,
            "transparent" as any
        );

        deploymentBlockNumber = 0;
    }

    console.log("\n#######################");
    console.log("#####    Checks  Rollup Manager  #####");
    console.log("#######################");
    console.log("FirechainZkEVMGlobalExitRootAddress:", await firechainRollupManagerContract.globalExitRootManager());
    console.log("polTokenAddress:", await firechainRollupManagerContract.pol());
    console.log("firechainZkEVMBridgeContract:", await firechainRollupManagerContract.bridgeAddress());

    console.log("pendingStateTimeout:", await firechainRollupManagerContract.pendingStateTimeout());
    console.log("trustedAggregatorTimeout:", await firechainRollupManagerContract.trustedAggregatorTimeout());

    // Check roles
    expect(await firechainRollupManagerContract.hasRole(DEFAULT_ADMIN_ROLE, timelockAddressRollupManager)).to.be.equal(
        true
    );
    expect(await firechainRollupManagerContract.hasRole(ADD_ROLLUP_TYPE_ROLE, timelockAddressRollupManager)).to.be.equal(
        true
    );
    expect(await firechainRollupManagerContract.hasRole(UPDATE_ROLLUP_ROLE, timelockAddressRollupManager)).to.be.equal(
        true
    );
    expect(
        await firechainRollupManagerContract.hasRole(ADD_EXISTING_ROLLUP_ROLE, timelockAddressRollupManager)
    ).to.be.equal(true);
    expect(await firechainRollupManagerContract.hasRole(TRUSTED_AGGREGATOR_ROLE, trustedAggregator)).to.be.equal(true);

    expect(await firechainRollupManagerContract.hasRole(OBSOLETE_ROLLUP_TYPE_ROLE, admin)).to.be.equal(true);
    expect(await firechainRollupManagerContract.hasRole(CREATE_ROLLUP_ROLE, admin)).to.be.equal(true);
    expect(await firechainRollupManagerContract.hasRole(TRUSTED_AGGREGATOR_ROLE_ADMIN, admin)).to.be.equal(true);
    expect(await firechainRollupManagerContract.hasRole(TWEAK_PARAMETERS_ROLE, admin)).to.be.equal(true);
    expect(await firechainRollupManagerContract.hasRole(SET_FEE_ROLE, admin)).to.be.equal(true);
    expect(await firechainRollupManagerContract.hasRole(STOP_EMERGENCY_ROLE, admin)).to.be.equal(true);

    expect(await firechainRollupManagerContract.hasRole(EMERGENCY_COUNCIL_ROLE, emergencyCouncilAddress)).to.be.equal(
        true
    );
    expect(await firechainRollupManagerContract.hasRole(EMERGENCY_COUNCIL_ADMIN, emergencyCouncilAddress)).to.be.equal(
        true
    );

    // Assert admin address
    expect(await upgrades.erc1967.getAdminAddress(precalculateRollupManager)).to.be.equal(proxyAdminAddress);
    expect(await upgrades.erc1967.getAdminAddress(precalculateGlobalExitRootAddress)).to.be.equal(proxyAdminAddress);
    expect(await upgrades.erc1967.getAdminAddress(proxyBridgeAddress)).to.be.equal(proxyAdminAddress);

    const outputJson = {
        firechainRollupManagerAddress: firechainRollupManagerContract.target,
        firechainZkEVMBridgeAddress: firechainZkEVMBridgeContract.target,
        firechainZkEVMGlobalExitRootAddress: firechainZkEVMGlobalExitRoot?.target,
        polTokenAddress,
        zkEVMDeployerContract: zkEVMDeployerContract.target,
        deployerAddress: deployer.address,
        timelockContractAddress: timelockContract.target,
        deploymentRollupManagerBlockNumber: deploymentBlockNumber,
        upgradeToULxLyBlockNumber: deploymentBlockNumber,
        admin,
        trustedAggregator,
        proxyAdminAddress,
        salt,
    };
    fs.writeFileSync(pathOutputJson, JSON.stringify(outputJson, null, 1));

    // Remove ongoing deployment
    fs.unlinkSync(pathOngoingDeploymentJson);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
