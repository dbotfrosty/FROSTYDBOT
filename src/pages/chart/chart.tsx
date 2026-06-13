import { useEffect, useRef, useState } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import chart_api from '@/external/bot-skeleton/services/api/chart-api';
import { useStore } from '@/hooks/useStore';
import {
    ActiveSymbolsRequest,
    ServerTimeRequest,
    TicksHistoryResponse,
    TicksStreamRequest,
    TradingTimesRequest,
} from '@deriv/api-types';
import { ChartTitle, SmartChart } from '@deriv/deriv-charts';
import { useDevice } from '@deriv-com/ui';
import ToolbarWidgets from './toolbar-widgets';
import '@deriv/deriv-charts/dist/smartcharts.css';

type TSubscription = {
    [key: string]: null | { unsubscribe?: () => void };
};

type TError = null | {
    error?: { code?: string; message?: string };
};

const subscriptions: TSubscription = {};

const Chart = observer(({ show_digits_stats }: { show_digits_stats: boolean }) => {
    const barriers: [] = [];
    const { common, ui } = useStore();
    const { chart_store, run_panel, dashboard } = useStore();
    const [isSafari, setIsSafari] = useState(false);
    const [is_connection_opened, setIsConnectionOpened] = useState(false);
    const chart_api_ref = useRef<typeof chart_api.api>(null);

    const {
        chart_type,
        getMarketsOrder,
        granularity,
        onSymbolChange,
        setChartStatus,
        symbol,
        updateChartType,
        updateGranularity,
        updateSymbol,
        setChartSubscriptionId,
        chart_subscription_id,
    } = chart_store;
    const chartSubscriptionIdRef = useRef(chart_subscription_id);
    const { isDesktop, isMobile } = useDevice();
    const { is_drawer_open } = run_panel;
    const { is_chart_modal_visible } = dashboard;
    const settings = {
        assetInformation: false,
        countdown: true,
        isHighestLowestMarkerEnabled: false,
        language: common.current_language.toLowerCase(),
        position: ui.is_chart_layout_default ? 'bottom' : 'left',
        theme: ui.is_dark_mode_on ? 'dark' : 'light',
    };

    useEffect(() => {
        const isSafariBrowser = () => {
            const ua = navigator.userAgent.toLowerCase();
            return ua.indexOf('safari') !== -1 && ua.indexOf('chrome') === -1 && ua.indexOf('android') === -1;
        };
        setIsSafari(isSafariBrowser());
    }, []);

    // Wait for chart_api.api WebSocket to be truly OPEN before enabling SmartChart
    useEffect(() => {
        let cancelled = false;
        let poll_interval: ReturnType<typeof setInterval> | null = null;

        const checkAndSet = () => {
            const api = chart_api.api;
            if (!api) return false;
            const state = api.connection?.readyState;
            if (state === WebSocket.OPEN) {
                chart_api_ref.current = api;
                if (!cancelled) setIsConnectionOpened(true);
                return true;
            }
            return false;
        };

        const start = async () => {
            // Init chart_api if not already
            if (!chart_api.api) {
                await chart_api.init();
            }

            // If already open, set immediately
            if (checkAndSet()) return;

            // Otherwise poll until open
            poll_interval = setInterval(() => {
                const api = chart_api.api;
                if (!api) return;
                const state = api.connection?.readyState;
                if (state === WebSocket.OPEN) {
                    chart_api_ref.current = api;
                    if (!cancelled) setIsConnectionOpened(true);
                    if (poll_interval) clearInterval(poll_interval);
                } else if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) {
                    // Dead connection - reinit
                    chart_api.init(true).then(() => {
                        // will be picked up on next interval tick
                    });
                }
            }, 100);
        };

        start();

        return () => {
            cancelled = true;
            if (poll_interval) clearInterval(poll_interval);
        };
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            try {
                Object.keys(subscriptions).forEach(id => {
                    const sub = subscriptions[id];
                    if (sub && typeof (sub as any).unsubscribe === 'function') {
                        (sub as any).unsubscribe();
                    }
                    delete subscriptions[id];
                });
                chart_api.api?.forgetAll('ticks');
            } catch {
                // ignore
            }
        };
    }, []);

    useEffect(() => {
        chartSubscriptionIdRef.current = chart_subscription_id;
    }, [chart_subscription_id]);

    useEffect(() => {
        if (!symbol) {
            updateSymbol();
            const retry = setInterval(() => {
                if (!symbol) updateSymbol();
                else clearInterval(retry);
            }, 500);
            return () => clearInterval(retry);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [symbol]);

    const getApi = () => chart_api_ref.current || chart_api.api;

    const requestAPI = async (req: ServerTimeRequest | ActiveSymbolsRequest | TradingTimesRequest) => {
        const api = getApi();
        if (!api) throw new Error('Chart API not initialized');
        return api.send(req);
    };

    const requestForgetStream = (subscription_id: string) => {
        if (!subscription_id) return;
        try {
            const sub = subscriptions[subscription_id];
            if (sub && typeof (sub as any).unsubscribe === 'function') {
                (sub as any).unsubscribe();
            }
            delete subscriptions[subscription_id];
            const api = getApi();
            api?.forget(subscription_id);
        } catch {
            // ignore
        }
    };

    const requestSubscribe = async (req: TicksStreamRequest, callback: (data: any) => void) => {
        const api = getApi();
        if (!api) return;

        try {
            // Unsubscribe RxJS listeners and clear our local map
            const prev_id = chartSubscriptionIdRef.current;
            if (prev_id) requestForgetStream(prev_id);

            // Tell the server to drop ALL stale tick subscriptions on this connection
            // This prevents the "AlreadySubscribed" error when the chart remounts
            try {
                await api.send({ forget_all: 'ticks' });
            } catch {
                // not a hard failure — proceed anyway
            }

            const history = await api.send(req);
            const subscription_id = history?.subscription?.id;
            setChartSubscriptionId(subscription_id);
            if (history) callback(history);

            if (req.subscribe === 1 && subscription_id) {
                const msg_subscription = api.onMessage()?.subscribe(
                    ({ data }: { data: TicksHistoryResponse & { subscription?: { id: string } } }) => {
                        if (
                            (data as any)?.subscription?.id === subscription_id ||
                            (data as any)?.tick?.id === subscription_id
                        ) {
                            callback(data);
                        }
                    }
                );
                subscriptions[subscription_id] = msg_subscription;
            }
        } catch (e) {
            if ((e as TError)?.error?.code === 'MarketIsClosed') callback([]);
            // eslint-disable-next-line no-console
            console.log((e as TError)?.error?.message);
        }
    };

    if (!symbol) return null;

    return (
        <div
            className={classNames('dashboard__chart-wrapper', {
                'dashboard__chart-wrapper--expanded': is_drawer_open && isDesktop,
                'dashboard__chart-wrapper--modal': is_chart_modal_visible && isDesktop,
                'dashboard__chart-wrapper--safari': isSafari,
            })}
            dir='ltr'
        >
            <SmartChart
                id='dbot'
                barriers={barriers}
                showLastDigitStats={show_digits_stats}
                chartControlsWidgets={null}
                enabledChartFooter={false}
                chartStatusListener={(v: boolean) => setChartStatus(!v)}
                toolbarWidget={() => (
                    <ToolbarWidgets
                        updateChartType={updateChartType}
                        updateGranularity={updateGranularity}
                        position={!isDesktop ? 'bottom' : 'top'}
                        isDesktop={isDesktop}
                    />
                )}
                chartType={chart_type}
                isMobile={isMobile}
                enabledNavigationWidget={isDesktop}
                granularity={granularity}
                requestAPI={requestAPI}
                requestForget={() => {}}
                requestForgetStream={requestForgetStream}
                requestSubscribe={requestSubscribe}
                settings={settings}
                symbol={symbol}
                topWidgets={() => <ChartTitle onChange={onSymbolChange} />}
                isConnectionOpened={is_connection_opened}
                getMarketsOrder={getMarketsOrder}
                isLive
                leftMargin={80}
            />
        </div>
    );
});

export default Chart;
