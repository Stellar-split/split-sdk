/**
 * E2E test setup — funds test accounts via Friendbot and deploys the contract.
 *
 * Exports a `setupE2E` function that returns funded keypairs and a deployed
 * contract ID. Results are written to test/e2e/.env.e2e so the test suite can
 * read them without re-deploying on every run.
 */

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(__dirname, ".env.e2e");

export const TESTNET_RPC = "https://soroban-testnet.stellar.org";
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const FRIENDBOT_URL = "https://friendbot.stellar.org";

/** Fund a Stellar testnet account via Friendbot. */
export async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Friendbot failed for ${publicKey}: ${body}`);
  }
}

/** Deploy the StellarSplit contract using the Stellar CLI and return its ID. */
function deployContract(secretKey: string): string {
  const wasmPath = join(__dirname, "../../contract/stellar_split.wasm");
  const result = execSync(
    `stellar contract deploy \
      --wasm ${wasmPath} \
      --source ${secretKey} \
      --network testnet`,
    { encoding: "utf8" }
  ).trim();
  return result;
}

export interface E2EEnv {
  contractId: string;
  creator: Keypair;
  payer: Keypair;
  recipient1: Keypair;
  recipient2: Keypair;
}

/** Read cached env or run full setup. */
export async function setupE2E(): Promise<E2EEnv> {
  if (existsSync(ENV_FILE)) {
    const raw = readFileSync(ENV_FILE, "utf8");
    const env = JSON.parse(raw) as {
      contractId: string;
      creatorSecret: string;
      payerSecret: string;
      recipient1Secret: string;
      recipient2Secret: string;
    };
    return {
      contractId: env.contractId,
      creator: Keypair.fromSecret(env.creatorSecret),
      payer: Keypair.fromSecret(env.payerSecret),
      recipient1: Keypair.fromSecret(env.recipient1Secret),
      recipient2: Keypair.fromSecret(env.recipient2Secret),
    };
  }

  // Generate fresh keypairs
  const creator = Keypair.random();
  const payer = Keypair.random();
  const recipient1 = Keypair.random();
  const recipient2 = Keypair.random();

  // Fund all accounts in parallel
  await Promise.all([
    fundAccount(creator.publicKey()),
    fundAccount(payer.publicKey()),
    fundAccount(recipient1.publicKey()),
    fundAccount(recipient2.publicKey()),
  ]);

  // Deploy contract using the creator account
  const contractId = deployContract(creator.secret());

  // Cache for subsequent runs
  writeFileSync(
    ENV_FILE,
    JSON.stringify(
      {
        contractId,
        creatorSecret: creator.secret(),
        payerSecret: payer.secret(),
        recipient1Secret: recipient1.secret(),
        recipient2Secret: recipient2.secret(),
      },
      null,
      2
    )
  );

  return { contractId, creator, payer, recipient1, recipient2 };
}
