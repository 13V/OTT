/** Local browser entry: transport + the official QR/mobile wallet picker. */
import { EthereumProvider } from '@walletconnect/ethereum-provider';
import { createAppKit } from '@reown/appkit/core';

window.OTTWalletConnectSDK = {
  async init(options) {
    const chain = {
      id: options.chainId,
      chainNamespace: 'eip155',
      caipNetworkId: 'eip155:' + options.chainId,
      name: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [options.rpc] } },
      blockExplorers: options.explorer ? { default: { name: 'Explorer', url: options.explorer } } : undefined,
    };
    const provider = await EthereumProvider.init({
      projectId: options.projectId,
      metadata: options.metadata,
      optionalChains: [options.chainId],
      optionalMethods: ['personal_sign', 'wallet_switchEthereumChain', 'wallet_addEthereumChain'],
      optionalEvents: ['accountsChanged', 'chainChanged'],
      rpcMap: { [options.chainId]: options.rpc },
      showQrModal: false,
      telemetryEnabled: false,
      customStoragePrefix: 'ott:' + new URL(options.metadata.url).pathname,
    });
    // Supplying our chain object avoids the SDK's generic Blockchain API RPC
    // fallback for a network it does not yet list. The transport and picker share
    // the same UniversalProvider, as in EthereumProvider's own AppKit integration.
    const modal = createAppKit({
      projectId: options.projectId,
      metadata: options.metadata,
      networks: [chain],
      defaultNetwork: chain,
      universalProvider: provider.signer,
      manualWCControl: true,
      enableInjected: false,
      enableEIP6963: false,
      enableCoinbase: false,
      enableWalletConnect: true,
      enableNetworkSwitch: false,
      // AppKit disconnects a supplied, already restored provider when this is
      // false. Reconnection here means preserving that session; manualWCControl
      // keeps new pairing prompts under our explicit connect() action.
      enableReconnect: true,
      enableWalletGuide: false,
      themeMode: 'light',
      themeVariables: {
        '--w3m-accent': '#b63c1c',
        '--w3m-font-family': 'Instrument Sans, sans-serif',
        '--w3m-z-index': 10000,
      },
      features: {
        analytics: false,
        email: false,
        socials: false,
        swaps: false,
        onramp: false,
        send: false,
        receive: false,
        history: false,
      },
      customRpcUrls: { ['eip155:' + options.chainId]: [{ url: options.rpc }] },
    });
    // AppKit attaches display_uri/session listeners asynchronously. Waiting for
    // its public ready() promise prevents a fast first pairing URI being lost.
    await modal.ready();
    async function connect() {
      if (provider.session && provider.accounts.length) return provider.accounts.slice();
      let unsubscribe;
      let opened = false;
      const cancelled = new Promise((_, reject) => {
        unsubscribe = modal.subscribeState((state) => {
          if (state.open) opened = true;
          if (opened && !state.open && !provider.session) {
            provider.signer.abortPairingAttempt();
            const error = new Error('Wallet connection was cancelled.');
            error.code = 4001;
            reject(error);
          }
        });
      });
      try {
        await modal.open({ view: 'Connect' });
        await Promise.race([provider.connect(), cancelled]);
        return provider.accounts.slice();
      } finally {
        unsubscribe?.();
        await modal.close();
      }
    }
    async function disconnect() {
      if (provider.session) await provider.disconnect();
      else provider.signer.abortPairingAttempt();
      await modal.close();
    }
    return {
      connect, disconnect,
      get accounts() { return provider.accounts; },
      get session() { return provider.session; },
      request: (args) => provider.request(args),
      on: (event, callback) => provider.on(event, callback),
      off: (event, callback) => provider.removeListener(event, callback),
      removeListener: (event, callback) => provider.removeListener(event, callback),
    };
  },
};
