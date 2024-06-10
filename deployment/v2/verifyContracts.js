/* eslint-disable import/no-dynamic-require, no-await-in-loop, no-restricted-syntax, guard-for-in */
require('dotenv').config();
const path = require('path');
const hre = require('hardhat');
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

const pathDeployOutputParameters = path.join(__dirname, './deploy_output.json');
const pathDeployParameters = path.join(__dirname, './deploy_parameters.json');

const deployParameters = require(pathDeployParameters);
const deployOutputParameters = require(pathDeployOutputParameters);

const pathCreateRollupOutput = path.join(__dirname, './create_rollup_output.json');

const createRollupOutputParameters = require(pathCreateRollupOutput);

async function main() {
    // load deployer account
    if (typeof process.env.ETHERSCAN_API_KEY === 'undefined') {
        throw new Error('Etherscan API KEY has not been defined');
    }

    // verify maticToken
    const polTokenName = 'Pol Token';
    const polTokenSymbol = 'POL';
    const polTokenInitialBalance = ethers.parseEther('20000000');

    try {
        // verify governance
        await hre.run(
            'verify:verify',
            {
                address: deployOutputParameters.polTokenAddress,
                constructorArguments: [
                    polTokenName,
                    polTokenSymbol,
                    deployOutputParameters.deployerAddress,
                    polTokenInitialBalance,
                ],
            },
        );
    } catch (error) {
        // expect(error.message.toLowerCase().includes('already verified')).to.be.equal(true);
    }

    const { minDelayTimelock } = deployParameters;
    const { timelockAdminAddress } = deployParameters;
    try {
        await hre.run(
            'verify:verify',
            {
                address: deployOutputParameters.timelockContractAddress,
                constructorArguments: [
                    minDelayTimelock,
                    [timelockAdminAddress],
                    [timelockAdminAddress],
                    timelockAdminAddress,
                    deployOutputParameters.firechainRollupManager,
                ],
            },
        );
    } catch (error) {
        expect(error.message.toLowerCase().includes('already verified')).to.be.equal(true);
    }

    // verify proxy admin
    try {
        await hre.run(
            'verify:verify',
            {
                address: deployOutputParameters.proxyAdminAddress,
            },
        );
    } catch (error) {
        expect(error.message.toLowerCase().includes('already verified')).to.be.equal(true);
    }

    // verify zkEVM address
    try {
        await hre.run(
            'verify:verify',
            {
                address: deployOutputParameters.firechainRollupManager,
                constructorArguments: [
                    deployOutputParameters.firechainZkEVMGlobalExitRootAddress,
                    deployOutputParameters.polTokenAddress,
                    deployOutputParameters.firechainZkEVMBridgeAddress,
                ],
            },
        );
    } catch (error) {
        // expect(error.message.toLowerCase().includes('proxyadmin')).to.be.equal(true);
    }

    // verify global exit root address
    try {
        await hre.run(
            'verify:verify',
            {
                address: deployOutputParameters.firechainZkEVMGlobalExitRootAddress,
                constructorArguments: [
                    deployOutputParameters.firechainRollupManager,
                    deployOutputParameters.firechainZkEVMBridgeAddress,
                ],
            },
        );
    } catch (error) {
        // expect(error.message.toLowerCase().includes('proxyadmin')).to.be.equal(true);
    }

    try {
        await hre.run(
            'verify:verify',
            {
                contract: '@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy',
                address: deployOutputParameters.firechainZkEVMBridgeAddress,
                constructorArguments: [
                    await upgrades.erc1967.getImplementationAddress(deployOutputParameters.firechainZkEVMBridgeAddress),
                    await upgrades.erc1967.getAdminAddress(deployOutputParameters.firechainZkEVMBridgeAddress),
                    '0x',
                ],
            },
        );
    } catch (error) {
        // expect(error.message.toLowerCase().includes('proxyadmin')).to.be.equal(true);
    }

    try {
        await hre.run(
            'verify:verify',
            {
                address: deployOutputParameters.firechainZkEVMBridgeAddress,
            },
        );
    } catch (error) {
        // expect(error.message.toLowerCase().includes('proxyadmin')).to.be.equal(true);
    }

    try {
        await hre.run(
            'verify:verify',
            {
                contract: 'contracts/v2/lib/FirechainTransparentProxy.sol:FirechainTransparentProxy',
                address: createRollupOutputParameters.rollupAddress,
                constructorArguments: [
                    await upgrades.erc1967.getImplementationAddress(createRollupOutputParameters.rollupAddress),
                    await upgrades.erc1967.getAdminAddress(createRollupOutputParameters.rollupAddress),
                    '0x',
                ],
            },
        );
    } catch (error) {
        // expect(error.message.toLowerCase().includes('proxyadmin')).to.be.equal(true);
    }

    // verify verifier
    try {
        await hre.run(
            'verify:verify',
            {
                address: createRollupOutputParameters.verifierAddress,
            },
        );
    } catch (error) {
        expect(error.message.toLowerCase().includes('already verified')).to.be.equal(true);
    }

    // verify zkEVM address or validium

    if (createRollupOutputParameters.consensusContract === 'FirechainZkEVMEtrog') {
        try {
            await hre.run(
                'verify:verify',
                {
                    contract: 'contracts/v2/consensus/zkEVM/FirechainZkEVMEtrog.sol:FirechainZkEVMEtrog',
                    address: createRollupOutputParameters.rollupAddress,
                    constructorArguments: [
                        deployOutputParameters.firechainZkEVMGlobalExitRootAddress,
                        deployOutputParameters.polTokenAddress,
                        deployOutputParameters.firechainZkEVMBridgeAddress,
                        deployOutputParameters.firechainRollupManager,
                    ],
                },
            );
        } catch (error) {
            // expect(error.message.toLowerCase().includes('proxyadmin')).to.be.equal(true);
        }
    } else if (createRollupOutputParameters.consensusContract === 'FirechainValidiumEtrog') {
        try {
            await hre.run(
                'verify:verify',
                {
                    contract: 'contracts/v2/consensus/validium/FirechainValidiumEtrog.sol:FirechainValidiumEtrog',
                    address: createRollupOutputParameters.rollupAddress,
                    constructorArguments: [
                        deployOutputParameters.firechainZkEVMGlobalExitRootAddress,
                        deployOutputParameters.polTokenAddress,
                        deployOutputParameters.firechainZkEVMBridgeAddress,
                        deployOutputParameters.firechainRollupManager,
                    ],
                },
            );
        } catch (error) {
            // expect(error.message.toLowerCase().includes('proxyadmin')).to.be.equal(true);
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
