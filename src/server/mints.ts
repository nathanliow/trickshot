/**
 * The assets a token is priced against.
 *
 * Everything this app computes is denominated in a swap's quote leg, and there
 * are only three worth recognising: wrapped SOL, which is almost every pool,
 * and the two dollar stablecoins, which need no conversion at all.
 */

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** Quote mints recognised when pairing a swap's two legs. */
export const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);
