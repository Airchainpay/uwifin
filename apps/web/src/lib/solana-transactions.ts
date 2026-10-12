import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
function associated(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN.toBuffer(), MINT.toBuffer()],
    ASSOCIATED,
  )[0];
}
/** Independently reconstruct the reviewed instructions before asking the wallet to sign. */
export function transferTransaction(
  sender: string,
  recipient: string,
  amount: bigint,
  blockhash: string,
  feePayer: string = sender,
  rentPayer: string = feePayer,
): Transaction {
  const owner = new PublicKey(sender);
  const destinationOwner = new PublicKey(recipient);
  const destination = associated(destinationOwner);
  const key = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({
    pubkey,
    isWritable,
    isSigner,
  });
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = 6;
  return new Transaction({ feePayer: new PublicKey(feePayer), recentBlockhash: blockhash }).add(
    new TransactionInstruction({
      programId: ASSOCIATED,
      keys: [
        key(new PublicKey(rentPayer), true, true),
        key(destination, true),
        key(destinationOwner),
        key(MINT),
        key(PublicKey.default),
        key(TOKEN),
      ],
      data: Buffer.from([1]),
    }),
    new TransactionInstruction({
      programId: TOKEN,
      keys: [
        key(associated(owner), true),
        key(MINT),
        key(destination, true),
        key(owner, false, true),
      ],
      data,
    }),
  );
}

/** Reject any provider rewrite beyond a sponsored fee payer and sponsored ATA rent. */
export function validateSponsoredTransaction(
  transaction: VersionedTransaction,
  sender: string,
  recipient: string,
  amount: bigint,
  feePayer: string,
  blockhash: string,
): void {
  if (
    transaction.version !== 0 ||
    transaction.message.addressTableLookups.length !== 0 ||
    feePayer === sender ||
    transaction.message.header.numRequiredSignatures !== 2 ||
    transaction.signatures.length !== 2 ||
    transaction.signatures[0].every((byte) => byte === 0) ||
    !transaction.message.staticAccountKeys[0].equals(new PublicKey(feePayer)) ||
    !transaction.message.staticAccountKeys[1].equals(new PublicKey(sender))
  )
    throw new Error('Solana fee sponsorship could not be verified.');
  const expected = transferTransaction(sender, recipient, amount, blockhash, feePayer);
  const expectedMessage = new TransactionMessage({
    payerKey: new PublicKey(feePayer),
    recentBlockhash: blockhash,
    instructions: expected.instructions,
  }).compileToV0Message();
  const describe = (message: TransactionMessage) =>
    JSON.stringify({
      feePayer: message.payerKey.toBase58(),
      recentBlockhash: message.recentBlockhash,
      instructions: message.instructions.map((ix) => ({
        program: ix.programId.toBase58(),
        data: ix.data.toString('hex'),
        keys: ix.keys.map((key) => ({
          address: key.pubkey.toBase58(),
          signer: key.isSigner,
          writable: key.pubkey.toBase58() === sender ? false : key.isWritable,
        })),
      })),
    });
  if (
    describe(TransactionMessage.decompile(transaction.message)) !==
    describe(TransactionMessage.decompile(expectedMessage))
  )
    throw new Error(
      'The sponsored transaction does not match your USDC transfer and rent sponsorship.',
    );
}
