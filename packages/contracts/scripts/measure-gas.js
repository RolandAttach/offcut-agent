// Measures what deployment and the recurring calls actually cost, so funding
// figures are read off a run rather than guessed. The FIRST publish is dearer
// than the rest: it writes three storage slots from zero, which costs 20k gas
// each, where overwriting a non-zero slot costs 5k. Steady state is what the
// monthly figure has to be based on.
const hre = require('hardhat');
const { MerkleTree } = require('../test/merkle.ts');

async function main() {
  const { ethers, upgrades } = hre;
  const [owner, publisher, alice] = await ethers.getSigners();

  const Token = await ethers.getContractFactory('TestToken');
  const token = await Token.deploy();
  await token.waitForDeployment();

  const Rewards = await ethers.getContractFactory('OffcutRewards');
  const rewards = await upgrades.deployProxy(
    Rewards,
    [owner.address, publisher.address, await token.getAddress()],
    { kind: 'uups' }
  );
  await rewards.waitForDeployment();
  await token.mint(await rewards.getAddress(), ethers.parseEther('1000'));

  let deployTotal = 0n;
  const height = await ethers.provider.getBlockNumber();
  for (let b = 0; b <= height; b += 1) {
    const blk = await ethers.provider.getBlock(b, true);
    for (const tx of blk?.prefetchedTransactions ?? []) {
      const r = await ethers.provider.getTransactionReceipt(tx.hash);
      if (r?.contractAddress) deployTotal += r.gasUsed;
    }
  }

  const used = [];
  for (let i = 1; i <= 4; i += 1) {
    const root = ethers.keccak256(ethers.toUtf8Bytes(`root-${i}`));
    const receipt = await (await rewards.connect(publisher).publishRoot(root)).wait();
    used.push(receipt.gasUsed);
  }

  console.log(JSON.stringify({
    deployAllContracts: deployTotal.toString(),
    firstPublish: used[0].toString(),
    steadyPublish: used[3].toString(),
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
