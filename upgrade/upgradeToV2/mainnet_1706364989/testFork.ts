/* eslint-disable no-await-in-loop, no-use-before-define, no-lonely-if */
/* eslint-disable no-console, no-inner-declarations, no-undef, import/no-unresolved */
import {expect} from "chai";
import path = require("path");
import fs = require("fs");

import * as dotenv from "dotenv";
dotenv.config({path: path.resolve(__dirname, "../../../.env")});
import {ethers, upgrades} from "hardhat";
import {FirechainRollupManager, FirechainZkEVMTimelock} from "../../../typechain-types";

import {takeSnapshot, time, reset, setBalance, setStorageAt} from "@nomicfoundation/hardhat-network-helpers";

const deployParameters = require("./deploy_parameters_mainnet.json");
const deployOutputParameters = require("./deploy_output_mainnet.json");
const upgradeOutput = require("./upgrade_output.json");

async function main() {
    const polTokenAddress = "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6"; // mainnet address
    const deployer = (await ethers.getSigners())[0];
    console.log("using signer: ", deployer.address);

    // hard fork
    const rpc = `https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`;
    await reset(rpc);
    await setBalance(deployer.address, 100n ** 18n);

    // Get timelock multisig
    const timelockMultisig = "0x242daE44F5d8fb54B198D03a94dA45B5a4413e21";
    await ethers.provider.send("hardhat_impersonateAccount", [timelockMultisig]);
    const multisigSigner = await ethers.getSigner(timelockMultisig as any);
    await setBalance(timelockMultisig, 100n ** 18n);

    const timelockContractFactory = await ethers.getContractFactory("FirechainZkEVMTimelock");
    const timelockContract = (await timelockContractFactory.attach(
        deployOutputParameters.timelockContractAddress
    )) as FirechainZkEVMTimelock;

    const timelockDelay = await timelockContract.getMinDelay();

    const firechainZkEVMFactory = await ethers.getContractFactory("FirechainZkEVM");
    const firechainZkEVMContract = (await firechainZkEVMFactory.attach(
        deployOutputParameters.firechainZkEVMAddress
    )) as FirechainZkEVM;

    const lastBatchSequenced = await firechainZkEVMContract.lastBatchSequenced();
    const emergencyCouncilAddress = await firechainZkEVMContract.owner();
    const trustedAggregator = await firechainZkEVMContract.trustedAggregator();

    await setStorageAt(firechainZkEVMContract.target, 116, lastBatchSequenced);

    const lastBatchVerified = await firechainZkEVMContract.lastVerifiedBatch();
    console.log({lastBatchSequenced});
    console.log({lastBatchVerified});

    await time.increase(timelockDelay);

    // Set storage slot

    // send mutlsig transaction
    const txUpgrade = {
        to: timelockContract.target,
        data: upgradeOutput.executeData,
    };

    const receipt = await (await multisigSigner.sendTransaction(txUpgrade)).wait();

    const RollupMangerFactory = await ethers.getContractFactory("FirechainRollupManager");
    const rollupManager = (await RollupMangerFactory.attach(
        deployOutputParameters.firechainZkEVMAddress
    )) as FirechainRollupManager;

    expect(await rollupManager.rollupCount()).to.be.equal(1);

    console.log("Contracts upgraded");

    // Deploy a validium
    const verifierAddress = upgradeOutput.verifierAddress;

    // impersonate timelock
    await ethers.provider.send("hardhat_impersonateAccount", [deployOutputParameters.timelockContractAddress]);
    const tiemelockSigner = await ethers.getSigner(deployOutputParameters.timelockContractAddress as any);
    await setBalance(deployOutputParameters.timelockContractAddress, 100n ** 18n);

    // Create consensus implementation
    const FirechainconsensusFactory = (await ethers.getContractFactory("FirechainValidiumEtrog", deployer)) as any;
    let FirechainconsensusContract = await FirechainconsensusFactory.deploy(
        deployOutputParameters.firechainZkEVMGlobalExitRootAddress,
        polTokenAddress,
        deployOutputParameters.firechainZkEVMBridgeAddress,
        deployOutputParameters.firechainZkEVMAddress
    );
    await FirechainconsensusContract.waitForDeployment();

    // Add a new rollup type with timelock
    const rollupCompatibilityID = 0;
    await (
        await rollupManager.connect(tiemelockSigner).addNewRollupType(
            FirechainconsensusContract.target,
            verifierAddress,
            7,
            rollupCompatibilityID,
            deployOutputParameters.genesisRoot, // should recalculate root!!!
            "super description"
        )
    ).wait();

    expect(await rollupManager.rollupTypeCount()).to.be.equal(1);

    // Create new rollup
    const chainID = 123213;
    const txDeployRollup = await rollupManager.connect(multisigSigner).createNewRollup(
        1,
        chainID,
        deployer.address, // admin
        deployer.address, // sequencer
        ethers.ZeroAddress,
        "trustedsequencer url",
        "network name"
    );

    console.log("Validum deployed");

    const receiptDeployRollup = (await txDeployRollup.wait()) as any;
    expect(await rollupManager.rollupCount()).to.be.equal(2);

    // Update rollup to this type: this is just a test is NOT intended to update our zkevm to a validium
    const txUpdateRollup = await rollupManager.connect(tiemelockSigner).updateRollup(
        upgradeOutput.newFirechainZKEVM, //new poylgon zkevm
        1, // new rollupTypeID
        "0x" // upgradeData
    );

    const receiptUpdateRollup = (await txUpdateRollup.wait()) as any;

    const rollupDataFinal2 = await rollupManager.rollupIDToRollupData(2);
    //expect(rollupDataFinal2.rollupContract).to.be.equal(upgradeOutput.newFirechainZKEVM);
    expect(rollupDataFinal2.chainID).to.be.equal(chainID);
    expect(rollupDataFinal2.verifier).to.be.equal(verifierAddress);
    expect(rollupDataFinal2.forkID).to.be.equal(7);
    expect(rollupDataFinal2.lastBatchSequenced).to.be.equal(1);
    expect(rollupDataFinal2.lastVerifiedBatch).to.be.equal(0);
    expect(rollupDataFinal2.lastPendingState).to.be.equal(0);
    expect(rollupDataFinal2.lastPendingStateConsolidated).to.be.equal(0);
    expect(rollupDataFinal2.lastVerifiedBatchBeforeUpgrade).to.be.equal(0);
    expect(rollupDataFinal2.rollupTypeID).to.be.equal(1);
    expect(rollupDataFinal2.rollupCompatibilityID).to.be.equal(0);

    const rollupDataFinal = await rollupManager.rollupIDToRollupData(1);
    expect(rollupDataFinal.rollupContract).to.be.equal(upgradeOutput.newFirechainZKEVM);
    expect(rollupDataFinal.chainID).to.be.equal(1101);
    expect(rollupDataFinal.verifier).to.be.equal(verifierAddress);
    expect(rollupDataFinal.forkID).to.be.equal(7);
    expect(rollupDataFinal.lastBatchSequenced).to.be.equal(lastBatchSequenced + 1n);
    expect(rollupDataFinal.lastVerifiedBatch).to.be.equal(lastBatchSequenced);
    expect(rollupDataFinal.lastPendingState).to.be.equal(0);
    expect(rollupDataFinal.lastPendingStateConsolidated).to.be.equal(0);
    expect(rollupDataFinal.lastVerifiedBatchBeforeUpgrade).to.be.equal(lastBatchSequenced);
    expect(rollupDataFinal.rollupTypeID).to.be.equal(1);
    expect(rollupDataFinal.rollupCompatibilityID).to.be.equal(0);

    console.log("Updated zkevm Succedd");

    //roles
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

    expect(await rollupManager.globalExitRootManager()).to.be.equal(
        deployOutputParameters.firechainZkEVMGlobalExitRootAddress
    );
    expect(await rollupManager.pol()).to.be.equal(polTokenAddress);
    expect(await rollupManager.bridgeAddress()).to.be.equal(deployOutputParameters.firechainZkEVMBridgeAddress);

    expect(await rollupManager.pendingStateTimeout()).to.be.equal(deployParameters.pendingStateTimeout);
    expect(await rollupManager.trustedAggregatorTimeout()).to.be.equal(deployParameters.trustedAggregatorTimeout);

    expect(await rollupManager.getBatchFee()).to.be.equal(ethers.parseEther("0.1"));
    expect(await rollupManager.getForcedBatchFee()).to.be.equal(ethers.parseEther("10"));
    expect(await rollupManager.calculateRewardPerBatch()).to.be.equal(0);

    // Check roles
    expect(await rollupManager.hasRole(DEFAULT_ADMIN_ROLE, deployOutputParameters.timelockContractAddress)).to.be.equal(
        true
    );
    expect(
        await rollupManager.hasRole(ADD_ROLLUP_TYPE_ROLE, deployOutputParameters.timelockContractAddress)
    ).to.be.equal(true);
    expect(await rollupManager.hasRole(UPDATE_ROLLUP_ROLE, deployOutputParameters.timelockContractAddress)).to.be.equal(
        true
    );
    expect(
        await rollupManager.hasRole(ADD_EXISTING_ROLLUP_ROLE, deployOutputParameters.timelockContractAddress)
    ).to.be.equal(true);

    expect(await rollupManager.hasRole(TRUSTED_AGGREGATOR_ROLE, trustedAggregator)).to.be.equal(true);

    expect(await rollupManager.hasRole(OBSOLETE_ROLLUP_TYPE_ROLE, deployParameters.admin)).to.be.equal(true);
    expect(await rollupManager.hasRole(CREATE_ROLLUP_ROLE, deployParameters.admin)).to.be.equal(true);
    expect(await rollupManager.hasRole(TRUSTED_AGGREGATOR_ROLE_ADMIN, deployParameters.admin)).to.be.equal(true);
    expect(await rollupManager.hasRole(TWEAK_PARAMETERS_ROLE, deployParameters.admin)).to.be.equal(true);
    expect(await rollupManager.hasRole(SET_FEE_ROLE, deployParameters.admin)).to.be.equal(true);
    expect(await rollupManager.hasRole(STOP_EMERGENCY_ROLE, deployParameters.admin)).to.be.equal(true);

    expect(await rollupManager.hasRole(EMERGENCY_COUNCIL_ROLE, emergencyCouncilAddress)).to.be.equal(true);
    expect(await rollupManager.hasRole(EMERGENCY_COUNCIL_ADMIN, emergencyCouncilAddress)).to.be.equal(true);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
