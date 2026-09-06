(function exposeCore(root, factory) {
  const api = factory();
  root.GmgnFomoCore = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function createCore() {
  "use strict";

  const TOKEN_NETWORK_IDS = Object.freeze({
    eth: 1,
    bsc: 56,
    base: 8453,
    sol: 1399811149,
    robinhood: 4663,
  });

  const FOMO_CHAIN_NAMES = Object.freeze({
    eth: "ethereum",
    bsc: "bnb",
    base: "base",
    sol: "solana",
    robinhood: "robinhood",
  });

  function validTokenAddress(value) {
    return typeof value === "string"
      && (/^0x[a-fA-F0-9]{40}$/.test(value) || /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(value));
  }

  function normalizeWalletAddress(value, networkId) {
    if (typeof value !== "string") return "";
    const address = value.trim();
    if (networkId === TOKEN_NETWORK_IDS.sol) {
      return /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(address) ? address : "";
    }
    if (!Object.values(TOKEN_NETWORK_IDS).includes(networkId)) return "";
    return /^0x[a-fA-F0-9]{40}$/.test(address) ? address.toLowerCase() : "";
  }

  function parseTokenRoute(pathname) {
    if (typeof pathname !== "string") return null;
    const match = pathname.match(/^\/([a-z0-9_-]+)\/token\/([^/?#]+)/i);
    if (!match) return null;

    const chain = match[1].toLowerCase();
    const networkId = TOKEN_NETWORK_IDS[chain];
    if (!networkId) return null;

    let address;
    try {
      address = decodeURIComponent(match[2]);
    } catch {
      return null;
    }
    if (!validTokenAddress(address)) return null;
    if (address.startsWith("0x")) address = address.toLowerCase();

    return {
      chain,
      address,
      networkId,
      fomoChain: FOMO_CHAIN_NAMES[chain],
    };
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function decimalParts(value) {
    if (value === null || value === undefined || value === "") return null;
    const source = String(value).trim();
    const match = source.match(/^\+?(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    if (!match) return null;
    const exponent = Number(match[3] || 0);
    if (!Number.isInteger(exponent) || Math.abs(exponent) > 1_000) return null;

    let digits = `${match[1]}${match[2] || ""}`.replace(/^0+(?=\d)/, "");
    let scale = (match[2] || "").length - exponent;
    if (scale < 0) {
      digits += "0".repeat(-scale);
      scale = 0;
    }
    while (scale > 0 && digits.endsWith("0")) {
      digits = digits.slice(0, -1);
      scale -= 1;
    }
    return { units: BigInt(digits || "0"), scale };
  }

  function decimalString(value) {
    const parts = decimalParts(value);
    if (!parts) return null;
    const digits = parts.units.toString();
    if (!parts.scale) return digits;
    const padded = digits.padStart(parts.scale + 1, "0");
    return `${padded.slice(0, -parts.scale)}.${padded.slice(-parts.scale)}`;
  }

  function decimalEqual(left, right) {
    const leftParts = decimalParts(left);
    const rightParts = decimalParts(right);
    if (!leftParts || !rightParts) return false;
    if (leftParts.scale === rightParts.scale) return leftParts.units === rightParts.units;
    if (leftParts.scale > rightParts.scale) {
      return leftParts.units === rightParts.units * (10n ** BigInt(leftParts.scale - rightParts.scale));
    }
    return leftParts.units * (10n ** BigInt(rightParts.scale - leftParts.scale)) === rightParts.units;
  }

  function decimalWithinRelativeTolerance(left, right, tolerancePpm = 2) {
    const leftParts = decimalParts(left);
    const rightParts = decimalParts(right);
    if (!leftParts || !rightParts
      || !Number.isInteger(tolerancePpm) || tolerancePpm < 0) return false;
    const scale = Math.max(leftParts.scale, rightParts.scale);
    const leftUnits = leftParts.units * (10n ** BigInt(scale - leftParts.scale));
    const rightUnits = rightParts.units * (10n ** BigInt(scale - rightParts.scale));
    if (leftUnits === rightUnits) return true;
    if (leftUnits === 0n) return false;
    const difference = leftUnits > rightUnits
      ? leftUnits - rightUnits
      : rightUnits - leftUnits;
    return difference * 1_000_000n <= leftUnits * BigInt(tolerancePpm);
  }

  function addDecimalStrings(values) {
    const parts = values.map(decimalParts);
    if (!parts.length || parts.some((item) => !item)) return null;
    const scale = Math.max(...parts.map((item) => item.scale));
    const units = parts.reduce((total, item) => (
      total + item.units * (10n ** BigInt(scale - item.scale))
    ), 0n);
    return decimalString(scale ? `${units.toString().padStart(scale + 1, "0").slice(0, -scale)}.${units.toString().padStart(scale + 1, "0").slice(-scale)}` : units.toString());
  }

  function decimalToUnits(value, decimals) {
    const parts = decimalParts(value);
    if (!parts || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
    if (parts.scale <= decimals) {
      return (parts.units * (10n ** BigInt(decimals - parts.scale))).toString();
    }
    const divisor = 10n ** BigInt(parts.scale - decimals);
    return parts.units % divisor === 0n ? (parts.units / divisor).toString() : null;
  }

  function safeHttpsUrl(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  }

  function safeTokenImageUrl(value) {
    const httpsUrl = safeHttpsUrl(value);
    if (httpsUrl) return httpsUrl;
    if (typeof value !== "string") return null;
    const source = value.trim();
    if (!/^ipfs:\/\//i.test(source)) return null;
    const path = source.replace(/^ipfs:\/\/(?:ipfs\/)?/i, "").split(/[?#]/, 1)[0];
    const segments = path.split("/");
    if (!/^[A-Za-z0-9]+$/.test(segments[0])
      || segments.slice(1).some((segment) => !/^[A-Za-z0-9._~%-]+$/.test(segment))) {
      return null;
    }
    return `https://ipfs.io/ipfs/${path}`;
  }

  function compactNumber(value, maximumFractionDigits = 1) {
    const number = finiteNumber(value);
    if (number === null) return "—";
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits,
    }).format(number);
  }

  function compactUsd(value, maximumFractionDigits = 1) {
    const number = finiteNumber(value);
    if (number === null) return "—";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits,
    }).format(number);
  }

  function preciseUsd(value) {
    const number = finiteNumber(value);
    if (number === null) return "—";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(number);
  }

  function percent(value) {
    const number = finiteNumber(value);
    if (number === null) return "—";
    return `${Math.abs(number).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  }

  function holdingPercent(value) {
    const number = finiteNumber(value);
    if (number === null) return "—";
    const absolute = Math.abs(number);
    const maximumFractionDigits = absolute > 0 && absolute < 0.01 ? 4 : absolute < 0.1 ? 3 : 2;
    return `${number.toLocaleString("en-US", { maximumFractionDigits })}%`;
  }

  function relativeTime(value, now = Date.now()) {
    const timestamp = typeof value === "number" && value < 10_000_000_000
      ? value * 1000
      : Date.parse(value);
    if (!Number.isFinite(timestamp)) return "";
    const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  function holderPnlPercent(holder) {
    const pnl = finiteNumber(holder?.pnl);
    const costBasis = finiteNumber(holder?.costBasis);
    if (pnl === null || costBasis === null || costBasis <= 0) return null;
    return (pnl / costBasis) * 100;
  }

  function averageEntryMarketCap(holder, totalSupply) {
    const price = finiteNumber(holder?.averageEntryPrice);
    const supply = finiteNumber(totalSupply);
    return price === null || supply === null ? null : price * supply;
  }

  return {
    TOKEN_NETWORK_IDS,
    FOMO_CHAIN_NAMES,
    validTokenAddress,
    normalizeWalletAddress,
    parseTokenRoute,
    finiteNumber,
    decimalString,
    decimalEqual,
    decimalWithinRelativeTolerance,
    addDecimalStrings,
    decimalToUnits,
    safeHttpsUrl,
    safeTokenImageUrl,
    compactNumber,
    compactUsd,
    preciseUsd,
    percent,
    holdingPercent,
    relativeTime,
    holderPnlPercent,
    averageEntryMarketCap,
  };
});
