//! The bought copies of the apps (server/store.ts: reportAppOpen, revokePlayCopy, takeAppleSlot).
use std::collections::HashSet;

use axum::http::StatusCode;

use super::Db;
use crate::apple_proof::ApplePurchase;
use crate::error::{ApiError, ApiResult};
use crate::ids::person_id;

/// The devices that one iPhone app purchase can prove, and the days after which an unused device frees its slot.
const APPLE_SLOTS_PER_PURCHASE: i64 = 5;
const APPLE_SLOT_IDLE_DAYS: i64 = 90;

impl Db {
    /// Takes the device slot of an iPhone app purchase for this player token, in one transaction. A device keeps its slot
    /// on later opens. A new token on the same device (cleared app data) takes the slot over, and the old token loses its
    /// proof. A new device gets a slot while the purchase holds fewer than APPLE_SLOTS_PER_PURCHASE; a slot unused for
    /// APPLE_SLOT_IDLE_DAYS frees itself first. 409 when the device holds another purchase, 403 when full.
    fn take_apple_slot(&mut self, token: &str, purchase: &ApplePurchase) -> ApiResult<()> {
        let key = format!("{}:{}", purchase.environment.as_str(), purchase.app_transaction_id);
        let device = &purchase.device;
        self.conn.execute_batch("BEGIN TRANSACTION")?;
        let result = (|| -> ApiResult<()> {
            let slot: Option<(String, String)> = self
                .query("FROM apple_slots SELECT purchase, token WHERE device = $device", &[("device", device)], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .into_iter()
                .next();
            match &slot {
                Some((held, _)) if *held != key => {
                    return Err(ApiError::new(StatusCode::CONFLICT, "This device holds another Apple purchase."));
                }
                Some((_, old)) if old != token => {
                    self.execute("UPDATE app_copies SET proved = false WHERE token = $old", &[("old", old)])?;
                }
                Some(_) => {}
                None => {
                    self.execute(
                        &format!("DELETE FROM apple_slots WHERE purchase = $purchase AND last_seen_at < now() - INTERVAL {APPLE_SLOT_IDLE_DAYS} DAY"),
                        &[("purchase", &key)],
                    )?;
                    let used: i64 = self
                        .query(
                            "FROM apple_slots SELECT count(*) WHERE purchase = $purchase AND token <> $token",
                            &[("purchase", &key), ("token", &token)],
                            |row| row.get(0),
                        )?
                        .into_iter()
                        .next()
                        .unwrap_or(0);
                    if used >= APPLE_SLOTS_PER_PURCHASE {
                        return Err(ApiError::new(
                            StatusCode::FORBIDDEN,
                            format!(
                                "This Apple purchase holds {APPLE_SLOTS_PER_PURCHASE} devices already. A device unused for {APPLE_SLOT_IDLE_DAYS} days frees its place."
                            ),
                        ));
                    }
                }
            }
            // A token lives on one device: its slot under another device id goes.
            self.execute("DELETE FROM apple_slots WHERE token = $token OR device = $device", &[("token", &token), ("device", device)])?;
            self.execute(
                "INSERT INTO apple_slots (device, purchase, token) VALUES ($device, $purchase, $token)",
                &[("device", device), ("purchase", &key), ("token", &token)],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => Ok(self.conn.execute_batch("COMMIT")?),
            Err(error) => {
                self.conn.execute_batch("ROLLBACK")?;
                Err(error)
            }
        }
    }

    /// The app opened on this device with a proved purchase, and the inviter that /share kept, or null. The first open
    /// makes the copy of the device; a later open only adds an inviter that the copy lacks. A self-invite counts for
    /// nobody. Answers whether the player holds a copy.
    pub fn report_app_open(&mut self, token: &str, by: Option<String>, apple: Option<ApplePurchase>) -> ApiResult<bool> {
        if let Some(purchase) = &apple {
            self.take_apple_slot(token, purchase)?;
        }
        let own: HashSet<String> = self.identity_of(Some(token))?.iter().map(|token| person_id(token)).collect();
        let invited_by = by.filter(|by| !own.contains(by));
        let owner = self.owner_of(token)?;
        let changed: Vec<Option<String>> = self.query(
            "INSERT INTO app_copies (token, owner, invited_by, proved) VALUES ($token, $owner, $by, true)
             ON CONFLICT (token) DO UPDATE SET invited_by = coalesce(app_copies.invited_by, excluded.invited_by), proved = true
             RETURNING invited_by",
            &[("token", &token), ("owner", &owner), ("by", &invited_by)],
            |row| row.get(0),
        )?;
        if let Some(by) = invited_by.filter(|by| changed.first() == Some(&Some(by.clone()))) {
            self.invite_changed(&by)?;
        }
        self.has_copy(token)
    }

    /// A valid, player-bound negative Play verdict revokes only this device, not its account's other devices.
    /// Limit: Apple refunds are not checked. Revisit when a player reports a refund.
    pub fn revoke_play_copy(&mut self, token: &str) -> ApiResult<bool> {
        self.execute("UPDATE app_copies SET proved = false WHERE token = $token", &[("token", &token)])?;
        self.has_copy(token)
    }
}
