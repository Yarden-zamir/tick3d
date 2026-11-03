//! The Google Play promo codes of the closed test (server/store.ts: addTesterCodes, testerCodes, claimTesterCode, testerClaims).
use axum::http::StatusCode;
use serde::Serialize;

use super::Db;
use crate::error::{ApiError, ApiResult};
use crate::ids::{person_id, sha256_hex};
use crate::protocol::ClaimRequest;
use crate::tester_codes::TesterCodeEntry;

/// The public list shows this many first characters of a code (HINT_LENGTH in src/share/codes.ts).
const HINT_LENGTH: usize = 3;

/// The codes have only A-Z and 0-9 (parseTesterCodeEntries), so a byte slice is a character slice.
pub fn hint_of(code: &str) -> String {
    code[..HINT_LENGTH.min(code.len())].to_owned()
}

/// The Gravatar hash of an email: SHA-256 of the trimmed, lower-case address (gravatarOf in server/tester-codes.ts).
/// Limit: the hash identifies an email to anybody who knows that email already. Revisit this if a tester objects.
fn gravatar_of(email: &str) -> String {
    sha256_hex(email.trim().to_lowercase().as_bytes())
}

/// One code of the public list. Never a code or an email.
#[derive(Serialize)]
pub struct TesterCode {
    id: i32,
    hint: String,
    claimed: bool,
    name: Option<String>,
    gravatar: Option<String>,
}

#[derive(Serialize)]
pub struct TesterCodes {
    codes: Vec<TesterCode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TesterClaim {
    hint: String,
    name: String,
    email: Option<String>,
    claimed_at: i64,
    invited_by: Option<String>,
}

#[derive(Serialize)]
pub struct TesterClaims {
    claims: Vec<TesterClaim>,
}

impl Db {
    /// Adds the codes that the table does not hold yet. A known code keeps its row and its claim. Returns how many are new.
    pub fn add_tester_codes(&mut self, entries: &[TesterCodeEntry]) -> ApiResult<usize> {
        let mut added = 0;
        for entry in entries {
            added += self
                .query(
                    "INSERT INTO tester_codes (code, name, claimed_at) VALUES ($code, $name, CASE WHEN $name IS NULL THEN NULL ELSE now() END)
                     ON CONFLICT DO NOTHING RETURNING id",
                    &[("code", &entry.code), ("name", &entry.name)],
                    |row| row.get::<_, i32>(0),
                )?
                .len();
        }
        Ok(added)
    }

    pub fn tester_codes(&mut self) -> ApiResult<TesterCodes> {
        let codes = self.query("FROM tester_codes SELECT id, code, name, email ORDER BY id", &[], |row| {
            let code: String = row.get(1)?;
            let name: Option<String> = row.get(2)?;
            let email: Option<String> = row.get(3)?;
            Ok(TesterCode {
                id: row.get(0)?,
                hint: hint_of(&code),
                claimed: name.is_some(),
                name,
                gravatar: email.as_deref().map(gravatar_of),
            })
        })?;
        Ok(TesterCodes { codes })
    }

    /// Gives the code to the tester once. 404 for an unknown id, 409 when somebody claimed it already.
    /// An invite from one of the claimer's own persons (a device or the account) is a self-invite, and counts for nobody.
    /// Limit: the server cannot tell an unknown person id from the id of a device that never played, so it keeps
    /// any well-formed `by`. Revisit this if fake invites show up in GET /api/testing/claims.
    /// Limit: Node also marks the invite achievements of the inviter as changed (inviteChanged). Add that with the achievements.
    pub fn claim_tester_code(&mut self, id: i64, claim: ClaimRequest, token: &str) -> ApiResult<String> {
        let own: Vec<String> = self.identity_of(Some(token))?.iter().map(|token| person_id(token)).collect();
        let invited_by = claim.by.filter(|by| !own.contains(by));
        let owner = self.owner_of(token)?;
        let claimed = self.query(
            "UPDATE tester_codes SET claimed_at = now(), name = $name, email = $email, invited_by = $invitedBy, claimed_token = $token, claimed_owner = $owner
             WHERE id = $id AND claimed_at IS NULL RETURNING code",
            &[("id", &id), ("name", &claim.name), ("email", &claim.email), ("invitedBy", &invited_by), ("token", &token), ("owner", &owner)],
            |row| row.get::<_, String>(0),
        )?;
        if let Some(code) = claimed.into_iter().next() {
            return Ok(code);
        }
        let known = self.query("FROM tester_codes SELECT id WHERE id = $id", &[("id", &id)], |row| row.get::<_, i32>(0))?;
        if known.is_empty() {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "No tester code has this id."));
        }
        Err(ApiError::new(StatusCode::CONFLICT, "Somebody else took this code a moment ago. Pick another one."))
    }

    /// The claims with their emails, oldest first, for the maintainers.
    pub fn tester_claims(&mut self) -> ApiResult<TesterClaims> {
        let claims = self.query(
            "FROM tester_codes SELECT code, name, email, epoch_ms(claimed_at) AS at, invited_by WHERE claimed_at IS NOT NULL ORDER BY claimed_at, id",
            &[],
            |row| {
                let code: String = row.get(0)?;
                Ok(TesterClaim { hint: hint_of(&code), name: row.get(1)?, email: row.get(2)?, claimed_at: row.get(3)?, invited_by: row.get(4)? })
            },
        )?;
        Ok(TesterClaims { claims })
    }
}
