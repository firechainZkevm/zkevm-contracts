/* eslint-disable no-await-in-loop, no-use-before-define, no-lonely-if */
/* eslint-disable no-console, no-inner-declarations, no-undef, import/no-unresolved */
import {expect} from "chai";
import path = require("path");
import fs = require("fs");

import * as dotenv from "dotenv";
dotenv.config({path: path.resolve(__dirname, "../../.env")});
import {ethers, upgrades, run} from "hardhat";

const outputJson = require("./upgrade_output.json");

const deployParameters = require("./deploy_parameters.json");
const deployOutputParameters = require("./deploy_output.json");
const upgradeParameters = require("./upgrade_parameters.json");

async function main() {
    // load deployer account
    if (typeof process.env.ETHERSCAN_API_KEY === "undefined") {
        throw new Error("Etherscan API KEY has not been defined");
    }

    const {polTokenAddress} = upgradeParameters;
    const currentBridgeAddress = deployOutputParameters.firechainZkEVMBridgeAddress;
    const currentGlobalExitRootAddress = deployOutputParameters.firechainZkEVMGlobalExitRootAddress;
    const currentFirechainZkEVMAddress = deployOutputParameters.firechainZkEVMAddress;

    try {
        // verify verifier
        await run("verify:verify", {
            address: outputJson.verifierAddress,
        });
    } catch (error: any) {
        // expect(error.message.toLowerCase().includes("already verified")).to.be.equal(true);
    }

    // Verify bridge
    try {
        await run("verify:verify", {
            address: currentBridgeAddress,
        });
    } catch (error: any) {
        // expect(error.message.toLowerCase().includes("already verified")).to.be.equal(true);
    }

    // verify global exit root
    try {
        await run("verify:verify", {
            address: currentGlobalExitRootAddress,
            constructorArguments: [currentFirechainZkEVMAddress, currentBridgeAddress],
        });
    } catch (error: any) {
        // expect(error.message.toLowerCase().includes("already verified")).to.be.equal(true);
    }

    // verify zkEVM implementation
    const implNewZkEVM = await upgrades.erc1967.getImplementationAddress(outputJson.newFirechainZKEVM);
    try {
        await run("verify:verify", {
            address: implNewZkEVM,
            constructorArguments: [
                currentGlobalExitRootAddress,
                polTokenAddress,
                currentBridgeAddress,
                currentFirechainZkEVMAddress,
            ],
        });
    } catch (error: any) {
        // expect(error.message.toLowerCase().includes("proxyadmin")).to.be.equal(true);
    }

    // verify zkEVM proxy
    try {
        await run("verify:verify", {
            address: outputJson.newFirechainZKEVM,
            constructorArguments: [implNewZkEVM, currentFirechainZkEVMAddress, "0x"],
        });
    } catch (error: any) {
        // expect(error.message.toLowerCase().includes("proxyadmin")).to.be.equal(true);
    }

    // verify zkEVM proxy
    try {
        await run("verify:verify", {
            address: outputJson.newFirechainZKEVM,
            constructorArguments: [implNewZkEVM, currentFirechainZkEVMAddress, "0x"],
        });
    } catch (error: any) {
        // expect(error.message.toLowerCase().includes("proxyadmin")).to.be.equal(true);
    }

    // verify rollup manager
    try {
        await run("verify:verify", {
            address: currentFirechainZkEVMAddress,
            constructorArguments: [currentGlobalExitRootAddress, polTokenAddress, currentBridgeAddress],
        });
    } catch (error: any) {
        // expect(error.message.toLowerCase().includes("proxyadmin")).to.be.equal(true);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
