import * as fs from 'fs';
import * as path from 'path';
import * as _ from 'lodash';
import * as ethUtil from 'ethereumjs-util';
import * as Web3 from 'web3';
import promisify = require('es6-promisify');
import solc = require('solc');
import {binPaths} from './solc/bin_paths';
import {utils} from './../util/utils';
import {
    ContractArtifact,
    ContractNetworks,
    ContractData,
    SolcErrors,
    CompilerOptions,
    ContractSources,
    ImportContents,
} from './../util/types';

const consoleLog = utils.consoleLog;
const readdirAsync = promisify(fs.readdir);
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const doesPathExist = promisify(fs.access);
const mkdirAsync = promisify(fs.mkdir);

const JSON_REPLACER: null = null;
const NUMBER_OF_JSON_SPACES = 4;
const SOLIDITY_FILE_EXTENSION = '.sol';

export class Compiler {
    private contractsDir: string;
    private networkId: number;
    private optimizerEnabled: number;
    private artifactsDir: string;

    constructor(options: CompilerOptions) {
        this.contractsDir = options.contractsDir;
        this.networkId = options.networkId;
        this.optimizerEnabled = options.optimizerEnabled;
        this.artifactsDir = options.artifactsDir;
    }
    /**
     * Compiles all Solidity files found it contractsDir and writes JSON artifacts to artifactsDir.
     */
    public async compileAll(): Promise<void> {
        await this.createArtifactsDirIfDoesNotExist();
        const sources: ContractSources = await this.getContractSources(this.contractsDir);
        const findImports: (importPath: string) => ImportContents = this.createFindImports(sources);

        const contractBaseNames = _.keys(sources);
        const errors: SolcErrors = {};

        _.each(contractBaseNames, async (contractBaseName: string): Promise<void> => {
            const source = sources[contractBaseName];
            const contractName = path.basename(contractBaseName, SOLIDITY_FILE_EXTENSION);
            const currentArtifactPath = `${this.artifactsDir}/${contractName}.json`;
            const sourceHash = `0x${ethUtil.sha3(source).toString('hex')}`;

            let currentArtifactString: string;
            let currentArtifact: ContractArtifact;
            let oldNetworks: ContractNetworks;
            let shouldCompile: boolean;
            try {
                const opts = {
                    encoding: 'utf8',
                };
                currentArtifactString = await readFileAsync(currentArtifactPath, opts);
                currentArtifact = JSON.parse(currentArtifactString);
                oldNetworks = currentArtifact.networks;
                const oldNetwork: ContractData = oldNetworks[this.networkId];
                shouldCompile = _.isUndefined(oldNetwork) ||
                                oldNetwork.keccak256 !== sourceHash ||
                                oldNetwork.optimizer_enabled !== this.optimizerEnabled;
            } catch (err) {
                shouldCompile = true;
            }

            if (shouldCompile) {
                const input = {
                    [contractBaseName]: source,
                };
                const solcVersion = this.parseSolidityVersion(source);
                const fullSolcVersion = binPaths[solcVersion];
                const solcBinPath = `./solc/solc_bin/${fullSolcVersion}`;
                const solcBin = require(solcBinPath);
                const solcInstance = solc.setupMethods(solcBin);

                consoleLog(`Compiling ${contractBaseName}...`);
                const sourcesToCompile = {
                    sources: input,
                };
                const compiled = solcInstance.compile(sourcesToCompile, this.optimizerEnabled, findImports);

                if (!_.isUndefined(compiled.errors)) {
                    _.each(compiled.errors, errMsg => {
                        const normalizedErrMsg = this.getNormalizedErrMsg(errMsg);
                        if (_.isUndefined(errors[normalizedErrMsg])) {
                            errors[normalizedErrMsg] = true;
                            consoleLog(normalizedErrMsg);
                        }
                    });
                }

                const contractIdentifier = `${contractBaseName}:${contractName}`;
                const abi: Web3.ContractAbi = JSON.parse(compiled.contracts[contractIdentifier].interface);
                const unlinked_binary = `0x${compiled.contracts[contractIdentifier].bytecode}`;
                const updated_at = Date.now();
                const contractData: ContractData = {
                    solc_version: solcVersion,
                    keccak256: sourceHash,
                    optimizer_enabled: this.optimizerEnabled,
                    abi,
                    unlinked_binary,
                    updated_at,
                };

                let newArtifact: ContractArtifact;
                if (!_.isUndefined(currentArtifactString)) {
                    newArtifact = {
                        ...currentArtifact,
                        networks: {
                            ...oldNetworks,
                            [this.networkId]: contractData,
                        }
                    };
                } else {
                    newArtifact = {
                        contract_name: contractName,
                        networks: {
                            [this.networkId]: contractData,
                        },
                    };
                }

                const artifactString = JSON.stringify(newArtifact, JSON_REPLACER, NUMBER_OF_JSON_SPACES);
                await writeFileAsync(currentArtifactPath, artifactString);
                consoleLog(`${contractBaseName} artifact saved!`);
            }
        });
    }
    /**
     * Recursively retrieves Solidity source code from directory.
     * @param  dirPath Directory to search.
     * @return Mapping of contract name to contract source.
     */
    private async getContractSources(dirPath: string): Promise<ContractSources> {
        let sources: ContractSources = {};
        let dirContents: string[];
        try {
            dirContents = await readdirAsync(dirPath);
        } catch (err) {
            throw new Error(`No directory found at ${dirPath}`);
        }
        for (const name of dirContents) {
            const contentPath = `${dirPath}/${name}`;
            if (path.extname(name) === SOLIDITY_FILE_EXTENSION) {
                try {
                    const opts = {
                        encoding: 'utf8',
                    };
                    sources[name] = await readFileAsync(contentPath, opts);
                    consoleLog(`Reading ${name} source...`);
                } catch (err) {
                    consoleLog(`Could not find file at ${contentPath}`);
                }
            } else {
                try {
                    const nestedSources = await this.getContractSources(contentPath);
                    sources = {
                      ...sources,
                      ...nestedSources,
                    };
                } catch(err) {
                    consoleLog(`${contentPath} is not a directory or ${SOLIDITY_FILE_EXTENSION} file`);
                }
            }
        }
        return sources;
    }
    /**
     * Searches Solidity source code for compiler version.
     * @param  source Source code of contract.
     * @return Solc compiler version.
     */
    private parseSolidityVersion(source: string): string {
        try {
            const solcVersion = source.match(/(?:solidity\s\^?)([0-9]{1,2}[.][0-9]{1,2}[.][0-9]{1,2})/)[1];
            return solcVersion;
        } catch (err) {
            throw new Error('Could not find Solidity version in source');
        }
    }
    /**
     * Normalizes the path found in the error message.
     * Example: converts 'base/Token.sol:6:46: Warning: Unused local variable' to 'Token.sol:6:46: Warning: Unused local variable'
     * This is used to prevent logging the same error multiple times.
     * @param  errMsg An error message from the compiled output.
     * @return The error message with directories truncated from the contract path.
     */
    private getNormalizedErrMsg(errMsg: string): string {
        try {
            const errPath = errMsg.match(/(.*\.sol)/)[0];
            const baseContract = path.basename(errPath);
            const normalizedErrMsg = errMsg.replace(errPath, baseContract);
            return normalizedErrMsg;
        } catch (err) {
            throw new Error('Could not find a path in error message');
        }

    }
    /**
     * Creates a callback to resolve dependencies with `solc.compile`.
     * @param  sources Mapping of contract names to contract source code.
     * @return A function to be used as a callback in `solc.compile`.
     */
    private createFindImports(sources: ContractSources): (importPath: string) => ImportContents {
        const findImports = (importPath: string): ImportContents => {
            const contractBaseName = path.basename(importPath);
            const source = sources[contractBaseName];
            const importContents: ImportContents = {
                contents: source,
            };
            return importContents;
        };
        return findImports;
    }
    /**
     * Creates the artifacts directory if it does not already exist.
     */
    private async createArtifactsDirIfDoesNotExist(): Promise<void> {
        if (!fs.existsSync(this.artifactsDir)) {
            consoleLog('Creating artifacts directory...');
            await mkdirAsync(this.artifactsDir);
        }
    }
}