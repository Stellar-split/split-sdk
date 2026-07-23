import { rpc, Contract, xdr } from "@stellar/stellar-sdk";

const server = new rpc.Server("https://soroban-testnet.stellar.org:443");
// We can create a valid contract ID
import { StrKey } from "@stellar/stellar-sdk";
const contractId = StrKey.encodeContract(Buffer.alloc(32));

async function run() {
  console.log("Testing getAccount...");
  try {
    const acc = await server.getAccount(contractId);
    console.log("getAccount success", acc);
  } catch(e) {
    console.log("getAccount err:", e.message);
  }

  console.log("Testing getLedgerEntries...");
  try {
    const { Address } = require("@stellar/stellar-sdk");
    const ledgerKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }));
    const data = await server.getLedgerEntries(ledgerKey);
    console.log("getLedgerEntries result:", data);
  } catch(e) {
    console.log("getLedgerEntries err:", e);
    if (e.errors) console.log("Aggregate errors:", e.errors);
  }
}
run();
