import {
  abi as V4_POOL_MANAGER_ABI,
  bytecode as V4_POOL_MANAGER_BYTECODE,
} from '@uniswap/core-next/artifacts/contracts/PoolManager.sol/PoolManager.json'
import {
  abi as POOL_SWAP_TEST_ABI,
  bytecode as POOL_SWAP_TEST_BYTECODE,
} from '@uniswap/core-next/artifacts/contracts/test/PoolSwapTest.sol/PoolSwapTest.json'
import {
  abi as TICK_MATH_TEST_ABI,
  bytecode as TICK_MATH_TEST_BYTECODE,
} from '@uniswap/core-next/artifacts/contracts/test/TickMathTest.sol/TickMathTest.json'
import { PoolManager, PoolSwapTest, TickMathTest } from '@uniswap/core-next/typechain'
import snapshotGasCost from '@uniswap/snapshot-gas-cost'
import { Wallet } from 'ethers'
import hre, { ethers, waffle } from 'hardhat'
import { LimitOrderHook, TestERC20 } from '../typechain'
import { expect } from './shared/expect'
import { tokensFixture } from './shared/fixtures'
import {
  encodeSqrtPriceX96,
  expandTo18Decimals,
  FeeAmount,
  getPoolId,
  getWalletForDeployingHookMask,
} from './shared/utilities'

const { constants } = ethers

const createFixtureLoader = waffle.createFixtureLoader

interface PoolKey {
  currency0: string
  currency1: string
  fee: FeeAmount
  tickSpacing: number
  hooks: string
}

const v4PoolManagerFixure = async ([wallet]: Wallet[]) => {
  return (await waffle.deployContract(
    wallet,
    {
      bytecode: V4_POOL_MANAGER_BYTECODE,
      abi: V4_POOL_MANAGER_ABI,
    },
    [10000]
  )) as PoolManager
}

const poolSwapTestFixture = async ([wallet]: Wallet[], manager: string) => {
  return (await waffle.deployContract(
    wallet,
    {
      bytecode: POOL_SWAP_TEST_BYTECODE,
      abi: POOL_SWAP_TEST_ABI,
    },
    [manager]
  )) as PoolSwapTest
}

const tickMathTestFixture = async ([wallet]: Wallet[]) => {
  return (await waffle.deployContract(wallet, {
    bytecode: TICK_MATH_TEST_BYTECODE,
    abi: TICK_MATH_TEST_ABI,
  })) as TickMathTest
}

describe('LimitOrderHooks', () => {
  let wallet: Wallet, other: Wallet

  let tokens: { token0: TestERC20; token1: TestERC20; token2: TestERC20 }
  let manager: PoolManager
  let limitOrderHook: LimitOrderHook
  let swapTest: PoolSwapTest
  let tickMath: TickMathTest

  const fixture = async () => {
    const tokens = await tokensFixture()

    const manager = await v4PoolManagerFixure([wallet])
    const swapTest = await poolSwapTestFixture([wallet], manager.address)
    const tickMath = await tickMathTestFixture([wallet])

    const limitOrderHookFactory = await ethers.getContractFactory('LimitOrderHook')

    // find a deployer that will generate a suitable hooks address
    const [hookDeployer, hookAddress] = getWalletForDeployingHookMask(
      {
        beforeInitialize: false,
        afterInitialize: true,
        beforeModifyPosition: false,
        afterModifyPosition: false,
        beforeSwap: false,
        afterSwap: true,
        beforeDonate: false,
        afterDonate: false,
      },
      'test onion mountain stove water behind cloud street robot salad load join'
    )

    ;[wallet] = await (ethers as any).getSigners()
    await wallet.sendTransaction({ to: hookDeployer.address, value: expandTo18Decimals(1) })

    // deploy the hook and make a contract instance
    await hookDeployer
      .connect(hre.ethers.provider)
      .sendTransaction(limitOrderHookFactory.getDeployTransaction(manager.address))
    const limitOrderHook = limitOrderHookFactory.attach(hookAddress) as LimitOrderHook

    const result = {
      tokens,
      manager,
      limitOrderHook,
      swapTest,
      tickMath,
    }

    for (const token of [tokens.token0, tokens.token1, tokens.token2]) {
      for (const spender of [result.swapTest, limitOrderHook]) {
        await token.connect(wallet).approve(spender.address, constants.MaxUint256)
        await token.connect(wallet).transfer(other.address, expandTo18Decimals(1))
        await token.connect(other).approve(spender.address, constants.MaxUint256)
      }
    }

    return result
  }

  let loadFixture: ReturnType<typeof createFixtureLoader>
  before('create fixture loader', async () => {
    ;[wallet, other] = await (ethers as any).getSigners()

    loadFixture = createFixtureLoader([wallet, other])
  })

  beforeEach('deploy fixture', async () => {
    ;({ tokens, manager, limitOrderHook, swapTest, tickMath } = await loadFixture(fixture))
  })

  it('bytecode size', async () => {
    expect(((await waffle.provider.getCode(limitOrderHook.address)).length - 2) / 2).to.matchSnapshot()
  })

  let key: PoolKey

  beforeEach('initialize pool with limit order hook', async () => {
    await manager.initialize(
      (key = {
        currency0: tokens.token0.address,
        currency1: tokens.token1.address,
        fee: FeeAmount.MEDIUM,
        tickSpacing: 60,
        hooks: limitOrderHook.address,
      }),
      encodeSqrtPriceX96(1, 1)
    )
  })

  describe('hook is initialized', async () => {
    describe('#getTickLowerLast', () => {
      it('works when the price is 1', async () => {
        expect(await limitOrderHook.getTickLowerLast(getPoolId(key))).to.eq(0)
      })

      it('works when the price is not 1', async () => {
        const otherKey = {
          ...key,
          tickSpacing: 61,
        }
        await manager.initialize(otherKey, encodeSqrtPriceX96(10, 1))
        expect(await limitOrderHook.getTickLowerLast(getPoolId(otherKey))).to.eq(22997)
      })
    })

    it('#epochNext', async () => {
      expect(await limitOrderHook.epochNext()).to.eq(1)
    })
  })

  describe('#place', async () => {
    it('#ZeroLiquidity', async () => {
      const tickLower = 0
      const zeroForOne = true
      const liquidity = 0
      await expect(limitOrderHook.place(key, tickLower, zeroForOne, liquidity)).to.be.revertedWith('ZeroLiquidity()')
    })

    describe('zeroForOne = true', async () => {
      const zeroForOne = true
      const liquidity = 1000000

      it('works from the right boundary of the current range', async () => {
        const tickLower = key.tickSpacing
        await limitOrderHook.place(key, tickLower, zeroForOne, liquidity)
        expect(await limitOrderHook.getEpoch(key, tickLower, zeroForOne)).to.eq(1)
        expect(
          await manager['getLiquidity(bytes32,address,int24,int24)'](
            getPoolId(key),
            limitOrderHook.address,
            tickLower,
            tickLower + key.tickSpacing
          )
        ).to.eq(liquidity)
      })

      it('works from the left boundary of the current range', async () => {
        const tickLower = 0
        await limitOrderHook.place(key, tickLower, zeroForOne, liquidity)
        expect(await limitOrderHook.getEpoch(key, tickLower, zeroForOne)).to.eq(1)
        expect(
          await manager['getLiquidity(bytes32,address,int24,int24)'](
            getPoolId(key),
            limitOrderHook.address,
            tickLower,
            tickLower + key.tickSpacing
          )
        ).to.eq(liquidity)
      })

      it('#CrossedRange', async () => {
        const tickLower = -key.tickSpacing
        await expect(limitOrderHook.place(key, tickLower, zeroForOne, liquidity)).to.be.revertedWith('CrossedRange()')
      })

      it('#InRange', async () => {
        await swapTest.swap(
          key,
          {
            zeroForOne: false,
            amountSpecified: 1, // swapping is free, there's no liquidity in the pool, so we only need to specify 1 wei
            sqrtPriceLimitX96: encodeSqrtPriceX96(1, 1).add(1),
          },
          {
            withdrawTokens: true,
            settleUsingTransfer: true,
          }
        )

        const tickLower = 0
        await expect(limitOrderHook.place(key, tickLower, zeroForOne, liquidity)).to.be.revertedWith('InRange()')
      })
    })

    describe('zeroForOne = false', async () => {
      const zeroForOne = false
      const liquidity = 1000000

      it('works up until the left boundary of the current range', async () => {
        const tickLower = -key.tickSpacing
        await limitOrderHook.place(key, tickLower, zeroForOne, liquidity)
        expect(await limitOrderHook.getEpoch(key, tickLower, zeroForOne)).to.eq(1)
        expect(
          await manager['getLiquidity(bytes32,address,int24,int24)'](
            getPoolId(key),
            limitOrderHook.address,
            tickLower,
            tickLower + key.tickSpacing
          )
        ).to.eq(liquidity)
      })

      it('#CrossedRange', async () => {
        const tickLower = 0
        await expect(limitOrderHook.place(key, tickLower, zeroForOne, liquidity)).to.be.revertedWith('CrossedRange()')
      })

      it('#InRange', async () => {
        await swapTest.swap(
          key,
          {
            zeroForOne: true,
            amountSpecified: 1, // swapping is free, there's no liquidity in the pool, so we only need to specify 1 wei
            sqrtPriceLimitX96: encodeSqrtPriceX96(1, 1).sub(1),
          },
          {
            withdrawTokens: true,
            settleUsingTransfer: true,
          }
        )

        const tickLower = -key.tickSpacing
        await expect(limitOrderHook.place(key, tickLower, zeroForOne, liquidity)).to.be.revertedWith('InRange()')
      })
    })

    it('works with different LPs', async () => {
      const tickLower = key.tickSpacing
      const zeroForOne = true
      const liquidity = 1000000
      await limitOrderHook.place(key, tickLower, zeroForOne, liquidity)
      await limitOrderHook.connect(other).place(key, tickLower, zeroForOne, liquidity)
      expect(await limitOrderHook.getEpoch(key, tickLower, zeroForOne)).to.eq(1)

      expect(
        await manager['getLiquidity(bytes32,address,int24,int24)'](
          getPoolId(key),
          limitOrderHook.address,
          tickLower,
          tickLower + key.tickSpacing
        )
      ).to.eq(liquidity * 2)

      const epochInfo = await limitOrderHook.epochInfos(1)
      expect(epochInfo.filled).to.be.false
      expect(epochInfo.currency0).to.eq(key.currency0)
      expect(epochInfo.currency1).to.eq(key.currency1)
      expect(epochInfo.token0Total).to.eq(0)
      expect(epochInfo.token1Total).to.eq(0)
      expect(epochInfo.liquidityTotal).to.eq(liquidity * 2)

      expect(await limitOrderHook.getEpochLiquidity(1, wallet.address)).to.eq(liquidity)
      expect(await limitOrderHook.getEpochLiquidity(1, other.address)).to.eq(liquidity)
    })
  })

  describe('#kill', async () => {
    const tickLower = 0
    const zeroForOne = true
    const liquidity = 1000000

    beforeEach('create limit order', async () => {
      await limitOrderHook.place(key, tickLower, zeroForOne, liquidity)
    })

    it('works', async () => {
      await expect(limitOrderHook.kill(key, tickLower, zeroForOne, wallet.address))
        .to.emit(tokens.token0, 'Transfer')
        .withArgs(manager.address, wallet.address, 2995)

      expect(await limitOrderHook.getEpochLiquidity(1, wallet.address)).to.eq(0)
    })

    it('gas cost', async () => {
      await snapshotGasCost(limitOrderHook.kill(key, tickLower, zeroForOne, wallet.address))
    })
  })

  describe('swap across the range', async () => {
    const tickLower = 0
    const zeroForOne = true
    const liquidity = 1000000
    const expectedToken0Amount = 2996

    beforeEach('create limit order', async () => {
      await expect(limitOrderHook.place(key, tickLower, zeroForOne, liquidity))
        .to.emit(tokens.token0, 'Transfer')
        .withArgs(wallet.address, manager.address, expectedToken0Amount)
    })

    beforeEach('swap', async () => {
      await expect(
        swapTest.swap(
          key,
          {
            zeroForOne: false,
            amountSpecified: expandTo18Decimals(1),
            sqrtPriceLimitX96: await tickMath.getSqrtRatioAtTick(key.tickSpacing),
          },
          {
            withdrawTokens: true,
            settleUsingTransfer: true,
          }
        )
      )
        .to.emit(tokens.token1, 'Transfer')
        .withArgs(wallet.address, manager.address, expectedToken0Amount + 19) // 3015, includes 19 wei of fees + price impact
        .to.emit(tokens.token0, 'Transfer')
        .withArgs(manager.address, wallet.address, expectedToken0Amount - 1) // 1 wei of dust

      expect(await limitOrderHook.getTickLowerLast(getPoolId(key))).to.be.eq(key.tickSpacing)

      expect((await manager.getSlot0(getPoolId(key))).tick).to.eq(key.tickSpacing)
    })

    it('#fill', async () => {
      const epochInfo = await limitOrderHook.epochInfos(1)

      expect(epochInfo.filled).to.be.true
      expect(epochInfo.token0Total).to.eq(0)
      expect(epochInfo.token1Total).to.eq(expectedToken0Amount + 17) // 3013, 2 wei of dust

      expect(
        await manager['getLiquidity(bytes32,address,int24,int24)'](
          getPoolId(key),
          limitOrderHook.address,
          tickLower,
          tickLower + key.tickSpacing
        )
      ).to.eq(0)
    })

    it('#withdraw', async () => {
      await expect(limitOrderHook.withdraw(1, wallet.address))
        .to.emit(tokens.token1, 'Transfer')
        .withArgs(manager.address, wallet.address, expectedToken0Amount + 17)

      const epochInfo = await limitOrderHook.epochInfos(1)

      expect(epochInfo.token0Total).to.eq(0)
      expect(epochInfo.token1Total).to.eq(0)
    })
  })

  describe('#afterSwap', async () => {
    const tickLower = 0
    const zeroForOne = true
    const liquidity = 1000000
    const expectedToken0Amount = 2996

    beforeEach('create limit order', async () => {
      await expect(limitOrderHook.place(key, tickLower, zeroForOne, liquidity))
        .to.emit(tokens.token0, 'Transfer')
        .withArgs(wallet.address, manager.address, expectedToken0Amount)
    })

    it('gas cost', async () => {
      await snapshotGasCost(
        swapTest.swap(
          key,
          {
            zeroForOne: false,
            amountSpecified: expandTo18Decimals(1),
            sqrtPriceLimitX96: await tickMath.getSqrtRatioAtTick(key.tickSpacing),
          },
          {
            withdrawTokens: true,
            settleUsingTransfer: true,
          }
        )
      )
    })
  })
})
