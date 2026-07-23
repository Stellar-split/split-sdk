export async function fundAccount(publicKey: string): Promise<void> {
  const friendbotUrl = `https://friendbot.stellar.org?addr=${publicKey}`;
  const res = await fetch(friendbotUrl);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Friendbot failed for ${publicKey}: ${body}`);
  }
}
