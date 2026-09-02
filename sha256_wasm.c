#include <stddef.h>
#include <stdint.h>
#include <wasm_simd128.h>

typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef uint64_t u64;
typedef int8_t i8;
typedef int16_t i16;
typedef int32_t i32;
typedef int64_t i64;
typedef float f32;
typedef double f64;

#define EXPORT(name) __attribute__((export_name(name), used))
#define NOINLINE __attribute__((noinline))
#define NONCES 100000000
#define NONCE_WIDTH 8
#define NONCE_ZEROES 44
#define MESSAGE_BYTES (NONCE_ZEROES + NONCE_WIDTH)
#define SEARCH_SEGMENT 65536

static const u32 K[64] = {
    UINT32_C(0x428a2f98), UINT32_C(0x71374491), UINT32_C(0xb5c0fbcf), UINT32_C(0xe9b5dba5),
    UINT32_C(0x3956c25b), UINT32_C(0x59f111f1), UINT32_C(0x923f82a4), UINT32_C(0xab1c5ed5),
    UINT32_C(0xd807aa98), UINT32_C(0x12835b01), UINT32_C(0x243185be), UINT32_C(0x550c7dc3),
    UINT32_C(0x72be5d74), UINT32_C(0x80deb1fe), UINT32_C(0x9bdc06a7), UINT32_C(0xc19bf174),
    UINT32_C(0xe49b69c1), UINT32_C(0xefbe4786), UINT32_C(0x0fc19dc6), UINT32_C(0x240ca1cc),
    UINT32_C(0x2de92c6f), UINT32_C(0x4a7484aa), UINT32_C(0x5cb0a9dc), UINT32_C(0x76f988da),
    UINT32_C(0x983e5152), UINT32_C(0xa831c66d), UINT32_C(0xb00327c8), UINT32_C(0xbf597fc7),
    UINT32_C(0xc6e00bf3), UINT32_C(0xd5a79147), UINT32_C(0x06ca6351), UINT32_C(0x14292967),
    UINT32_C(0x27b70a85), UINT32_C(0x2e1b2138), UINT32_C(0x4d2c6dfc), UINT32_C(0x53380d13),
    UINT32_C(0x650a7354), UINT32_C(0x766a0abb), UINT32_C(0x81c2c92e), UINT32_C(0x92722c85),
    UINT32_C(0xa2bfe8a1), UINT32_C(0xa81a664b), UINT32_C(0xc24b8b70), UINT32_C(0xc76c51a3),
    UINT32_C(0xd192e819), UINT32_C(0xd6990624), UINT32_C(0xf40e3585), UINT32_C(0x106aa070),
    UINT32_C(0x19a4c116), UINT32_C(0x1e376c08), UINT32_C(0x2748774c), UINT32_C(0x34b0bcb5),
    UINT32_C(0x391c0cb3), UINT32_C(0x4ed8aa4a), UINT32_C(0x5b9cca4f), UINT32_C(0x682e6ff3),
    UINT32_C(0x748f82ee), UINT32_C(0x78a5636f), UINT32_C(0x84c87814), UINT32_C(0x8cc70208),
    UINT32_C(0x90befffa), UINT32_C(0xa4506ceb), UINT32_C(0xbef9a3f7), UINT32_C(0xc67178f2)};

static inline u32
LoadBE32(const u8 *bytes)
{
    return ((u32)bytes[0] << 24) | ((u32)bytes[1] << 16) |
           ((u32)bytes[2] << 8) | (u32)bytes[3];
}

static inline u32
RotateRight(u32 value, unsigned int count)
{
    return (value >> count) | (value << (32 - count));
}

static u8 input_bytes[128] __attribute__((aligned(16)));
static u8 output_hash[32] __attribute__((aligned(16)));
static u32 midstate[8] __attribute__((aligned(16)));
static u32 hot_state_11[8] __attribute__((aligned(16)));

static void
CompressSHA256(u32 state[8], const u8 block[64])
{
    u32 w[64];
    u32 a = state[0], b = state[1], c = state[2], d = state[3];
    u32 e = state[4], f = state[5], g = state[6], h = state[7];
    for (size_t i = 0; i < 16; ++i) {
        w[i] = LoadBE32(block + i * 4);
    }
    for (size_t i = 16; i < 64; ++i) {
        u32 s0 = RotateRight(w[i - 15], 7) ^ RotateRight(w[i - 15], 18) ^ (w[i - 15] >> 3);
        u32 s1 = RotateRight(w[i - 2], 17) ^ RotateRight(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    for (size_t i = 0; i < 64; ++i) {
        u32 s1 = RotateRight(e, 6) ^ RotateRight(e, 11) ^ RotateRight(e, 25);
        u32 ch = g ^ (e & (f ^ g));
        u32 t1 = h + s1 + ch + K[i] + w[i];
        u32 s0 = RotateRight(a, 2) ^ RotateRight(a, 13) ^ RotateRight(a, 22);
        u32 maj = b ^ ((a ^ b) & (b ^ c));
        u32 t2 = s0 + maj;
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
}

static void
StoreHash(const u32 state[8])
{
    v128_t lo = wasm_v128_load(state);
    v128_t hi = wasm_v128_load(state + 4);
    lo = wasm_i8x16_shuffle(lo, lo, 3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12);
    hi = wasm_i8x16_shuffle(hi, hi, 3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12);
    wasm_v128_store(output_hash, lo);
    wasm_v128_store(output_hash + 16, hi);
}

static void
FormatNonceUnchecked(u32 value, u8 digits[NONCE_WIDTH])
{
    size_t i = NONCE_WIDTH;

    while (i) {
        --i;
        digits[i] = (u8)('0' + value % 10);
        value /= 10;
    }
}

static void
HashDigits(const u8 digits[NONCE_WIDTH])
{
    u8 block[64] = {0};
    u32 state[8];
    __builtin_memset(block, '0', NONCE_ZEROES);
    __builtin_memcpy(block + NONCE_ZEROES, digits, NONCE_WIDTH);
    block[MESSAGE_BYTES] = 0x80;
    block[62] = 0x05;
    block[63] = 0xa0;
    __builtin_memcpy(state, midstate, sizeof(state));
    CompressSHA256(state, block);
    StoreHash(state);
}

#define VADD(a, b) wasm_i32x4_add((a), (b))
#define VSUB(a, b) wasm_i32x4_sub((a), (b))
#define VAND(a, b) wasm_v128_and((a), (b))
#define VOR(a, b) wasm_v128_or((a), (b))
#define VXOR(a, b) wasm_v128_xor((a), (b))
#define VSPLAT(a) wasm_i32x4_splat((int)(a))
#define VSHR(a, n) wasm_u32x4_shr((a), (n))
#define VROR(a, n) VOR(VSHR((a), (n)), wasm_i32x4_shl((a), 32 - (n)))
#define SS0(a) VXOR(VXOR(VROR((a), 7), VROR((a), 18)), VSHR((a), 3))
#define SS1(a) VXOR(VXOR(VROR((a), 17), VROR((a), 19)), VSHR((a), 10))

static inline v128_t
AddASCIIDecimal(v128_t a, v128_t b)
{
    v128_t t1 = VADD(VADD(a, b), VSPLAT(UINT32_C(0x96969696)));
    v128_t t2 = VAND(t1, VSPLAT(UINT32_C(0x30303030)));
    v128_t t3 = VSUB(t1, VSHR(t2, 3));
    return VOR(VAND(t3, VSPLAT(UINT32_C(0x0f0f0f0f))), VSPLAT(UINT32_C(0x30303030)));
}

#define ROUND(a, b, c, d, e, f, g, h, message, constant) \
    do { \
        v128_t sum1 = VXOR(VXOR(VROR((e), 6), VROR((e), 11)), VROR((e), 25)); \
        v128_t choose = VXOR((g), VAND((e), VXOR((f), (g)))); \
        v128_t t1 = VADD(VADD((h), sum1), VADD(choose, VADD((message), VSPLAT(constant)))); \
        v128_t sum0 = VXOR(VXOR(VROR((a), 2), VROR((a), 13)), VROR((a), 22)); \
        v128_t axb = VXOR((a), (b)); \
        v128_t majority = VXOR((b), VAND(axb, bxc)); \
        (d) = VADD((d), t1); \
        (h) = VADD(t1, VADD(sum0, majority)); \
        bxc = axb; \
    } while (0)

#define EXPAND(slot) \
    do { \
        w[(slot)] = VADD(VADD(w[(slot)], SS0(w[((slot) + 1) & 15])), \
                         VADD(w[((slot) + 9) & 15], SS1(w[((slot) + 14) & 15]))); \
    } while (0)

#define EXPAND_ROUND(slot, a, b, c, d, e, f, g, h, base) \
    do { \
        EXPAND(slot); \
        ROUND(a, b, c, d, e, f, g, h, w[(slot)], K[(base) + (slot)]); \
    } while (0)

#define EXPAND16(base) \
    do { \
        EXPAND_ROUND(0, a, b, c, d, e, f, g, h, base); \
        EXPAND_ROUND(1, h, a, b, c, d, e, f, g, base); \
        EXPAND_ROUND(2, g, h, a, b, c, d, e, f, base); \
        EXPAND_ROUND(3, f, g, h, a, b, c, d, e, base); \
        EXPAND_ROUND(4, e, f, g, h, a, b, c, d, base); \
        EXPAND_ROUND(5, d, e, f, g, h, a, b, c, base); \
        EXPAND_ROUND(6, c, d, e, f, g, h, a, b, base); \
        EXPAND_ROUND(7, b, c, d, e, f, g, h, a, base); \
        EXPAND_ROUND(8, a, b, c, d, e, f, g, h, base); \
        EXPAND_ROUND(9, h, a, b, c, d, e, f, g, base); \
        EXPAND_ROUND(10, g, h, a, b, c, d, e, f, base); \
        EXPAND_ROUND(11, f, g, h, a, b, c, d, e, base); \
        EXPAND_ROUND(12, e, f, g, h, a, b, c, d, base); \
        EXPAND_ROUND(13, d, e, f, g, h, a, b, c, base); \
        EXPAND_ROUND(14, c, d, e, f, g, h, a, b, base); \
        EXPAND_ROUND(15, b, c, d, e, f, g, h, a, base); \
    } while (0)

static void
PrepareHotState11(void)
{
    u32 a = midstate[0], b = midstate[1], c = midstate[2], d = midstate[3];
    u32 e = midstate[4], f = midstate[5], g = midstate[6], h = midstate[7];
    for (size_t i = 0; i < 11; ++i) {
        u32 s1 = RotateRight(e, 6) ^ RotateRight(e, 11) ^ RotateRight(e, 25);
        u32 ch = g ^ (e & (f ^ g));
        u32 t1 = h + s1 + ch + K[i] + UINT32_C(0x30303030);
        u32 s0 = RotateRight(a, 2) ^ RotateRight(a, 13) ^ RotateRight(a, 22);
        u32 maj = b ^ ((a ^ b) & (b ^ c));
        u32 t2 = s0 + maj;
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }
    hot_state_11[0] = a;
    hot_state_11[1] = b;
    hot_state_11[2] = c;
    hot_state_11[3] = d;
    hot_state_11[4] = e;
    hot_state_11[5] = f;
    hot_state_11[6] = g;
    hot_state_11[7] = h;
}

static void
PrepareHotStart12(u32 word_11, u32 state[8], u32 *word_18)
{
    u32 a = hot_state_11[0], b = hot_state_11[1], c = hot_state_11[2], d = hot_state_11[3];
    u32 e = hot_state_11[4], f = hot_state_11[5], g = hot_state_11[6], h = hot_state_11[7];
    u32 s1 = RotateRight(e, 6) ^ RotateRight(e, 11) ^ RotateRight(e, 25);
    u32 ch = g ^ (e & (f ^ g));
    u32 t1 = h + s1 + ch + K[11] + word_11;
    u32 s0 = RotateRight(a, 2) ^ RotateRight(a, 13) ^ RotateRight(a, 22);
    u32 maj = b ^ ((a ^ b) & (b ^ c));
    u32 t2 = s0 + maj;
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
    state[0] = a;
    state[1] = b;
    state[2] = c;
    state[3] = d;
    state[4] = e;
    state[5] = f;
    state[6] = g;
    state[7] = h;
    *word_18 = word_11 + UINT32_C(0xd6a92928);
}

static void
ComputeFirstWords(const u32 hot[8], u32 word_18, u32 word_11, v128_t word_12, u32 output[4])
{
    v128_t w[16];
    v128_t zero = VSPLAT(0);
    v128_t a = VSPLAT(hot[4]);
    v128_t b = VSPLAT(hot[5]);
    v128_t c = VSPLAT(hot[6]);
    v128_t d = VSPLAT(hot[7]);
    v128_t e = VSPLAT(hot[0]);
    v128_t f = VSPLAT(hot[1]);
    v128_t g = VSPLAT(hot[2]);
    v128_t h = VSPLAT(hot[3]);
    v128_t bxc = VXOR(f, g);
    for (size_t base = 4; base < 11; ++base) {
        w[base] = VSPLAT(UINT32_C(0x30303030));
    }
    w[11] = VSPLAT(word_11);
    w[12] = word_12;
    w[13] = VSPLAT(UINT32_C(0x80000000));
    w[14] = zero;
    w[15] = VSPLAT(0x5a0);

    ROUND(e, f, g, h, a, b, c, d, w[12], K[12]);
    ROUND(d, e, f, g, h, a, b, c, w[13], K[13]);
    ROUND(c, d, e, f, g, h, a, b, w[14], K[14]);
    ROUND(b, c, d, e, f, g, h, a, w[15], K[15]);
    w[0] = VSPLAT(UINT32_C(0xcacacaca));
    w[1] = VSPLAT(UINT32_C(0xcd2ecacb));
    w[2] = VSPLAT(word_18);
    ROUND(a, b, c, d, e, f, g, h, w[0], K[16]);
    ROUND(h, a, b, c, d, e, f, g, w[1], K[17]);
    ROUND(g, h, a, b, c, d, e, f, w[2], K[18]);
    w[3] = VADD(word_12, VSPLAT(UINT32_C(0x56aa6f1a)));
    ROUND(f, g, h, a, b, c, d, e, w[3], K[19]);
    EXPAND_ROUND(4, e, f, g, h, a, b, c, d, 16);
    w[5] = VADD(SS1(w[3]), VSPLAT(UINT32_C(0x9a9a9a9a)));
    ROUND(d, e, f, g, h, a, b, c, w[5], K[21]);
    EXPAND_ROUND(6, c, d, e, f, g, h, a, b, 16);
    EXPAND_ROUND(7, b, c, d, e, f, g, h, a, 16);
    EXPAND_ROUND(8, a, b, c, d, e, f, g, h, 16);
    EXPAND_ROUND(9, h, a, b, c, d, e, f, g, 16);
    EXPAND_ROUND(10, g, h, a, b, c, d, e, f, 16);
    EXPAND_ROUND(11, f, g, h, a, b, c, d, e, 16);
    EXPAND_ROUND(12, e, f, g, h, a, b, c, d, 16);
    EXPAND_ROUND(13, d, e, f, g, h, a, b, c, 16);
    EXPAND_ROUND(14, c, d, e, f, g, h, a, b, 16);
    EXPAND_ROUND(15, b, c, d, e, f, g, h, a, 16);
    for (size_t base = 32; base < 64; base += 16) {
        EXPAND16(base);
    }
    a = VADD(a, VSPLAT(midstate[0]));
    wasm_v128_store(output, a);
}

EXPORT("input") u32 GetInputBuffer(void) __asm__("input");
EXPORT("hash") u32 GetHashBuffer(void) __asm__("hash");
EXPORT("prepare") i32 PrepareSHA256(void) __asm__("prepare");
EXPORT("hash_nonce") i32 HashNonce(u32 nonce) __asm__("hash_nonce");
EXPORT("search") i32 SearchNonces(u32 start, u32 count, u32 difficulty) __asm__("search");

u32
GetInputBuffer(void)
{
    return (u32)(uintptr_t)input_bytes;
}

u32
GetHashBuffer(void)
{
    return (u32)(uintptr_t)output_hash;
}

i32
PrepareSHA256(void)
{
    static const u32 INITIAL[8] = {
        UINT32_C(0x6a09e667), UINT32_C(0xbb67ae85), UINT32_C(0x3c6ef372), UINT32_C(0xa54ff53a),
        UINT32_C(0x510e527f), UINT32_C(0x9b05688c), UINT32_C(0x1f83d9ab), UINT32_C(0x5be0cd19)
    };
    __builtin_memcpy(midstate, INITIAL, sizeof(midstate));
    CompressSHA256(midstate, input_bytes);
    CompressSHA256(midstate, input_bytes + 64);
    PrepareHotState11();
    return 1;
}

i32
HashNonce(u32 nonce)
{
    u8 digits[NONCE_WIDTH];
    if (nonce >= NONCES) {
        return 0;
    }
    FormatNonceUnchecked(nonce, digits);
    HashDigits(digits);
    return 1;
}

static NOINLINE i32
SearchSegment(u32 start, u32 count, u32 target_limit)
{
    u8 digits[NONCE_WIDTH];
    u32 hot[8];
    u32 word_18;
    u32 words[4];
    u32 remaining;

    remaining = count;
    while (remaining) {
        u32 low = start % 10000;
        u32 epoch_count = 10000 - low;
        u32 total_batches;
        u32 batches;
        u32 word_11;
        v128_t word_12;

        if (epoch_count > remaining) {
            epoch_count = remaining;
        }
        total_batches = (epoch_count + 3) / 4;
        batches = total_batches;
        FormatNonceUnchecked(start, digits);
        word_11 = LoadBE32(digits);
        PrepareHotStart12(word_11, hot, &word_18);
        word_12 = AddASCIIDecimal(
            VSPLAT(LoadBE32(digits + 4)),
            wasm_i32x4_make(0x30303030, 0x30303031, 0x30303032, 0x30303033));

        for (;;) {
            ComputeFirstWords(hot, word_18, word_11, word_12, words);
            if (target_limit) {
                if (words[0] < target_limit) {
                    u32 batch_offset = (total_batches - batches) * 4;
                    return (i32)(start + batch_offset);
                }
                if (words[1] < target_limit) {
                    u32 batch_offset = (total_batches - batches) * 4;
                    if (batch_offset + 1 < epoch_count) {
                        return (i32)(start + batch_offset + 1);
                    }
                }
                if (words[2] < target_limit) {
                    u32 batch_offset = (total_batches - batches) * 4;
                    if (batch_offset + 2 < epoch_count) {
                        return (i32)(start + batch_offset + 2);
                    }
                }
                if (words[3] < target_limit) {
                    u32 batch_offset = (total_batches - batches) * 4;
                    if (batch_offset + 3 < epoch_count) {
                        return (i32)(start + batch_offset + 3);
                    }
                }
            }
            if (--batches == 0) {
                break;
            }
            word_12 = AddASCIIDecimal(word_12, VSPLAT(UINT32_C(0x30303034)));
        }
        start += epoch_count;
        remaining -= epoch_count;
    }
    return -1;
}

i32
SearchNonces(u32 start, u32 count, u32 difficulty)
{
    u32 remaining;
    u32 target_limit;

    if (count == 0 || start >= NONCES || count > NONCES - start || difficulty > 6) {
        return -2;
    }
    target_limit = difficulty ? UINT32_C(1) << (32 - difficulty * 4) : 0;
    remaining = count;
    while (remaining) {
        u32 segment_count = remaining < SEARCH_SEGMENT ? remaining : SEARCH_SEGMENT;
        i32 nonce = SearchSegment(start, segment_count, target_limit);

        if (nonce >= 0) {
            return nonce;
        }
        start += segment_count;
        remaining -= segment_count;
    }
    return -1;
}

#undef EXPAND16
#undef EXPAND_ROUND
#undef EXPAND
#undef ROUND
#undef SS1
#undef SS0
#undef VROR
#undef VSHR
#undef VSPLAT
#undef VXOR
#undef VOR
#undef VAND
#undef VSUB
#undef VADD
