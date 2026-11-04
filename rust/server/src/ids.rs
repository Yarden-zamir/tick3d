//! Player tokens, account tokens and person ids, as in src/protocol.ts.
use sha2::{Digest, Sha256};

pub const ACCOUNT_TOKEN_PREFIX: &str = "account-";
pub const PERSON_ID_PREFIX: &str = "tick3d-person:";
pub const PERSON_ID_LENGTH: usize = 16;

/// The token that a seat holds when a logged-in player takes it (accountToken in server/store.ts).
/// The padding is the same as `lpad(github_id::VARCHAR, 16, '0')` in SQL, also for a negative id.
pub fn account_token(account_id: i64) -> String {
    format!("{ACCOUNT_TOKEN_PREFIX}{account_id:0>16}")
}

/// The public id of a token (personId in src/protocol.ts): never send a token itself to a page.
pub fn person_id(token: &str) -> String {
    sha256_hex(format!("{PERSON_ID_PREFIX}{token}").as_bytes())[..PERSON_ID_LENGTH].to_owned()
}

/// The SHA-256 of `bytes` in lower-case hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_tokens_pad_like_sql() {
        assert_eq!(account_token(8178413), "account-0000000008178413");
        // lpad('-5', 16, '0') puts the sign after the zeros.
        assert_eq!(account_token(-5), "account-00000000000000-5");
    }
}
