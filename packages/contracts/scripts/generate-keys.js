/**
 * Generates the two keys the reward system needs.
 *
 * Run: pnpm --filter @offcut/contracts keys [output directory]
 *
 * Nothing secret is printed. The addresses go to the terminal, the keys go to
 * files in a directory OUTSIDE the repository — because a private key that
 * reaches a terminal reaches scrollback, shell history, CI logs and anything
 * watching the session, and a key that lands inside a checkout eventually
 * reaches a commit.
 *
 * Two keys, because the powers are deliberately split:
 *
 *   owner      every power there is. Funds, withdraws, upgrades, pauses. This
 *              one deserves a hardware wallet; the file below is a starting
 *              point, not a resting place. Import the phrase into a Ledger or a
 *              multisig and transfer ownership before real money is involved.
 *   publisher  signs a reward root every ten minutes from a server, so assume
 *              it will eventually leak. It can misdirect future rewards and it
 *              cannot take a single token — OffcutRewards enforces that, and
 *              the contract tests prove it.
 */

const { ethers } = require('ethers');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const outDir = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'offcut-keys'));

const ROLES = [
  {
    role: 'owner',
    purpose: 'Owns the OFFCUT reward contracts.',
    can: 'fund, withdraw, upgrade, pause, change the publisher',
    cannot: 'nothing — this key has every power there is',
    advice: 'Move this to a hardware wallet or a multisig before funding anything.',
  },
  {
    role: 'publisher',
    purpose: 'Signs the reward root every 10 minutes from the server.',
    can: 'publish reward amounts, and only that',
    cannot: 'withdraw, upgrade, pause, or replace itself',
    advice: 'This one lives on the server. Fund it with a little ETH for gas, nothing more.',
  },
];

fs.mkdirSync(outDir, { recursive: true });

const made = [];

for (const spec of ROLES) {
  const file = path.join(outDir, `${spec.role}.txt`);

  // Refuse to overwrite: a second run must never silently replace a key that
  // already owns a deployed contract.
  if (fs.existsSync(file)) {
    console.error(`${file} already exists. Refusing to overwrite an existing key.`);
    process.exit(1);
  }

  // Draws from the platform CSPRNG. The 12-word phrase is what makes this
  // importable into MetaMask, a Ledger, or a multisig signer later.
  const wallet = ethers.Wallet.createRandom();

  fs.writeFileSync(
    file,
    [
      `OFFCUT ${spec.role.toUpperCase()} KEY`,
      `Generated ${new Date().toISOString()} on this machine. Never sent anywhere.`,
      '',
      `PURPOSE   ${spec.purpose}`,
      `CAN       ${spec.can}`,
      `CANNOT    ${spec.cannot}`,
      `ADVICE    ${spec.advice}`,
      '',
      `ADDRESS   ${wallet.address}`,
      '',
      'PRIVATE KEY — never paste into a chat, an email, a form, or a web page.',
      `          ${wallet.privateKey}`,
      '',
      'RECOVERY PHRASE — anyone who reads these twelve words owns this wallet.',
      `          ${wallet.mnemonic.phrase}`,
      '',
      'Write the phrase on paper and keep it somewhere else as well. If this file',
      'is lost and the phrase is not written down, the wallet and everything in it',
      'is gone permanently. There is no reset and nobody can recover it for you.',
      '',
    ].join('\n'),
    'utf8'
  );

  made.push({ role: spec.role, address: wallet.address, file });
}

for (const entry of made) {
  console.log(`${entry.role.padEnd(10)} ${entry.address}`);
}
console.log(`\nKeys written to ${outDir}`);
console.log('Addresses above are public. What is in those files is not.');
