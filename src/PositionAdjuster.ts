import { injectable, inject } from 'inversify';
import { ConfigStore, BrokerConfig, ActivePairStore, CashMarginType, BrokerMap, BrokerPosition } from './types';
import { getLogger } from '@bitr/logger';
import * as _ from 'lodash';
import symbols from './symbols';
import { DateTime, Interval } from 'luxon';
import { AwaitableEventEmitter } from '@bitr/awaitable-event-emitter';
import QuoineApi from './Quoine/BrokerApi';
import BitbankccApi, { Asset } from '@bitr/bitbankcc-api';
import CoincheckApi from './Coincheck/BrokerApi';
import PositionService from './PositionService';
import { delay } from './util';

@injectable()
export default class PositionAdjuster extends AwaitableEventEmitter {
    private readonly log = getLogger(this.constructor.name);
    private isRunning: boolean;
    private retryCount: number;
    private skipCount: number;

    constructor(
        @inject(symbols.ConfigStore) private readonly configStore: ConfigStore,
        private readonly positionService: PositionService,
        @inject(symbols.ActivePairStore) private readonly activePairStore: ActivePairStore
    ) {
        super();
        this.retryCount = 0;
        this.skipCount = 0;
    }

    async start(): Promise<void> {
        this.log.debug('Starting Position Adjuster...');
        this.log.debug('Started Position Adjuster.');
    }

    async stop(): Promise<void> {
        this.log.debug('Stopping Position Adjuster...');
        this.log.debug('Stopped Position Adjuster.');
    }
    public async seek(): Promise<void> {
        if (this.isRunning) {
            this.log.debug('Position adjuster is already running. Skipped iteration.');
            if (this.retryCount > 30) {
                this.isRunning = false;
            } else {
                this.retryCount++;
            }
            return;
        }

        if (this.skipCount < 30){
            this.skipCount++;
            return;
        }
        this.skipCount = 0;

        try {
            this.isRunning = true;
            this.retryCount = 0;

            const positionMap : BrokerMap<BrokerPosition> = this.positionService.positionMap

            const activePairsMap = await this.activePairStore.getAll();
            if (activePairsMap.length === 0) {                
                this.log.info('No pairs right now. Checking balances after 5 sec...');
                await delay(5000);

                _(this.configStore.config.brokers)
                    .filter(b => b.enabled)
                    .filter(b => this.timeFilter(b))
                    .forEach(async brokerConfig => {
                        // const { baseCcy } = splitSymbol(this.configStore.config.symbol);
                        // const positions = await this.brokerAdapterRouter.getPositions(brokerConfig.broker);
                        const position = positionMap[brokerConfig.broker];
                        const baseCcyPosition = position.baseCcyPosition;                        
                        //const baseCcyPosition = positions.get(baseCcy);
                        if (baseCcyPosition === undefined) {
                            //throw new Error(`Unable to find base ccy position in ${brokerConfig.broker}. ${JSON.stringify([...positions])}`);
                            this.log.warn(`Unable to find base ccy position in ${brokerConfig.broker}. ${JSON.stringify([positionMap])}`);                            
                            return;
                        }
                        const maxLongPosition = brokerConfig.maxLongPosition;
                        /*
                        const allowedLongSize = _.max([
                            0,
                            new Decimal(brokerConfig.maxLongPosition).minus(baseCcyPosition).toNumber()
                        ]) as number;
                        */
                        this.log.info("BTC position for %s : %d", brokerConfig.broker, baseCcyPosition);
                        if (brokerConfig.cashMarginType === CashMarginType.Cash) {
                            if (brokerConfig.broker === "Bitbankcc") {
                                const bbApi = new BitbankccApi(brokerConfig.key, brokerConfig.secret);                                
                                //キャッシュの場合は、最大ロングポジションの半分 +- 20% にずれた場合に調整すること
                                if (baseCcyPosition > maxLongPosition * 0.60) {
                                    console.log('Adjusting position for %s.', brokerConfig.broker);

                                    const bbAssetsResponse = await bbApi.getAssets();
                                    const bbBtc = bbAssetsResponse.assets.find(b => b.asset === 'btc') as Asset;
                                    const amount = bbBtc.free_amount - maxLongPosition/ 2;
                                    const request = {
                                        pair: 'btc_jpy',
                                        type: 'market',
                                        side: 'sell',
                                        price: 0,
                                        amount: amount
                                    };
                                    try {
                                        console.log(`Selling ${amount}...`);
                                        const response = await bbApi.sendOrder(request);
                                        console.log(response);
                                    } catch (ex) {
                                        console.log(ex.message);
                                    }
                                    console.log('Done.');
                                }
                                else if (baseCcyPosition < maxLongPosition * 0.40) {
                                    console.log('Adjusting position for %s.', brokerConfig.broker);
                                    const bbAssetsResponse = await bbApi.getAssets();
                                    const bbBtc = bbAssetsResponse.assets.find(b => b.asset === 'btc') as Asset;
                                    const amount = maxLongPosition / 2 - bbBtc.free_amount;
                                    const request = {
                                        pair: 'btc_jpy',
                                        type: 'market',
                                        side: 'buy',
                                        price: 0,
                                        amount: amount
                                    };
                                    try {
                                        console.log(`Buying ${amount}...`);
                                        const response = await bbApi.sendOrder(request);
                                        console.log(response);
                                    } catch (ex) {
                                        console.log(ex.message);
                                    }
                                    console.log('Done.');
                                }
                            }
                            if (brokerConfig.broker === "Coincheck") {
                                const ccApi = new CoincheckApi(brokerConfig.key, brokerConfig.secret);

                                if (baseCcyPosition > maxLongPosition * 0.60) {
                                    console.log('Adjusting position for %s.', brokerConfig.broker);                                    
                                    const request = {
                                        pair: 'btc_jpy',
                                        order_type: 'market_sell',
                                        amount: baseCcyPosition - maxLongPosition / 2
                                      };
                                      const reply = await ccApi.newOrder(request);
                                      if (!reply.success) {
                                        throw new Error('Send failed.');
                                      }                                    
                                }
                                else if (baseCcyPosition < maxLongPosition * 0.40) {
                                    console.log('Adjusting position for %s.', brokerConfig.broker); 
                                    const response = await ccApi.getRate('btc_jpy');                            
                                    const rate = response.rate;
                                    const request = {
                                        pair: 'btc_jpy',
                                        order_type: 'market_buy',
                                        market_buy_amount:  (maxLongPosition / 2 - baseCcyPosition) * rate
                                      };
                                      const reply = await ccApi.newOrder(request);
                                      if (!reply.success) {
                                        throw new Error('Send failed.');
                                      }                                                                        
                                }
                            }

                        }
                        else if (brokerConfig.cashMarginType === CashMarginType.NetOut && brokerConfig.broker === "Quoine") {
                            //ただ単純にポジションを全クローズするだけ

                            if (baseCcyPosition > 0.005 || baseCcyPosition < -0.005) {
                                console.log('Adjusting position for %s because the position is %d.', brokerConfig.broker, baseCcyPosition);
                                const quApi = new QuoineApi(brokerConfig.key, brokerConfig.secret);
                                await quApi.closeAll();
                                console.log('Done.');
                            }
                        }
                    })
            }
            this.log.debug('Adjusted.');
        } catch (ex) {
            this.log.error(ex.message);
            this.log.debug(ex.stack);
        } finally {
            await delay(5000);            
            this.isRunning = false;
            this.log.info('Finished Position Adjuster');            
        }
    }

    private timeFilter(brokerConfig: BrokerConfig): boolean {
        if (_.isEmpty(brokerConfig.noTradePeriods)) {
            return true;
        }
        const current = DateTime.local();
        const outOfPeriod = period => {
            const interval = Interval.fromISO(`${period[0]}/${period[1]}`);
            if (!interval.isValid) {
                this.log.warn('Invalid noTradePeriods. Ignoring the config.');
                return true;
            }
            return !interval.contains(current);
        };
        return brokerConfig.noTradePeriods.every(outOfPeriod);
    }

} /* istanbul ignore next */
