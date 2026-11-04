//! The check of Nearby handshake codes (decodeSignal in src/nearby/signal.ts). The server only checks a code and reads
//! its Hello: it never rebuilds the description. Format: "T3A1." (offer) or "T3B1." (answer), then base64url of
//! deflate-raw of a JSON array [ufrag, pwd, fingerprint, setup, candidates, device, name].
use base64::Engine;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use serde::Serialize;
use serde_json::Value;

use crate::protocol::{js_length, js_trim, whole};

const OFFER_TAG: &str = "T3A1.";
const ANSWER_TAG: &str = "T3B1.";
const HELLO_NAME_MAX_LENGTH: usize = 24;
/// MAX_CODE_LENGTH in src/nearby/signal.ts: the longest code text.
pub const MAX_CODE_LENGTH: usize = 2000;
const MAX_INFLATED_BYTES: usize = 4000;
const MAX_CANDIDATES: usize = 8;
const ICE_CHARS: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/";
const ADDRESS_CHARS: &str = "0123456789abcdefABCDEF.:";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignalKind {
    Offer,
    Answer,
}

impl SignalKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SignalKind::Offer => "offer",
            SignalKind::Answer => "answer",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    Phone,
    Tablet,
    Computer,
}

/// The device kind and name of the sender of a code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hello {
    pub device: DeviceKind,
    pub name: String,
}

/// atob after the base64url swap: it takes both alphabets, drops ASCII white space, ignores padding and trailing bits.
const FORGIVING: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
);

fn from_base64_url(text: &str) -> Option<Vec<u8>> {
    let standard: String = text
        .chars()
        .filter(|char| !matches!(char, '\t' | '\n' | '\x0C' | '\r' | ' '))
        .map(|char| match char {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    FORGIVING.decode(standard.trim_end_matches('=')).ok()
}

fn only_chars(text: &str, allowed: &str) -> bool {
    text.chars().all(|char| allowed.contains(char))
}

/// normalizeHelloName: 1 to 24 UTF-16 units after a trim.
fn hello_name(value: &Value) -> Option<&str> {
    let name = js_trim(value.as_str()?);
    (1..=HELLO_NAME_MAX_LENGTH).contains(&js_length(name)).then_some(name)
}

/// readCandidate: [address, port, priority]. An address that starts with "~" is the 16 bytes of an mDNS name.
fn valid_candidate(value: &Value) -> Option<()> {
    let [address, port, priority] = value.as_array()?.as_slice() else { return None };
    let address = address.as_str()?;
    let valid_address = match address.strip_prefix('~') {
        Some(packed) => from_base64_url(packed)?.len() == 16,
        None => (3..=45).contains(&address.len()) && only_chars(address, ADDRESS_CHARS),
    };
    (valid_address && whole(port, 65_535)? >= 1 && whole(priority, 0xffff_ffff).is_some()).then_some(())
}

/// The kind and Hello of a code, or None for any code that decodeSignal refuses.
pub fn decode_signal(text: &str) -> Option<(SignalKind, Hello)> {
    let code = js_trim(text);
    if js_length(code) > MAX_CODE_LENGTH {
        return None;
    }
    let (kind, body) = match (code.strip_prefix(OFFER_TAG), code.strip_prefix(ANSWER_TAG)) {
        (Some(body), _) => (SignalKind::Offer, body),
        (None, Some(body)) => (SignalKind::Answer, body),
        (None, None) => return None,
    };
    let inflated = miniz_oxide::inflate::decompress_to_vec_with_limit(&from_base64_url(body)?, MAX_INFLATED_BYTES).ok()?;
    let parsed: Value = serde_json::from_str(std::str::from_utf8(&inflated).ok()?).ok()?;
    let [ufrag, pwd, fingerprint, setup, candidates, device, name] = parsed.as_array()?.as_slice() else { return None };
    let ufrag = ufrag.as_str()?;
    let pwd = pwd.as_str()?;
    let fingerprint = from_base64_url(fingerprint.as_str()?)?;
    let candidates = candidates.as_array()?;
    let device = match device.as_str()? {
        "p" => DeviceKind::Phone,
        "t" => DeviceKind::Tablet,
        "c" => DeviceKind::Computer,
        _ => return None,
    };
    let name_text = name.as_str()?;
    let valid = (4..=256).contains(&ufrag.len())
        && only_chars(ufrag, ICE_CHARS)
        && (22..=256).contains(&pwd.len())
        && only_chars(pwd, ICE_CHARS)
        && fingerprint.len() == 32
        && matches!(setup.as_str()?, "a" | "c" | "p")
        && hello_name(name) == Some(name_text)
        && (1..=MAX_CANDIDATES).contains(&candidates.len());
    if !valid {
        return None;
    }
    candidates.iter().try_for_each(valid_candidate)?;
    Some((kind, Hello { device, name: name_text.to_owned() }))
}

/// A valid code for the tests, as encodeSignal makes one.
#[cfg(test)]
pub fn test_code(kind: SignalKind, fields: &Value) -> String {
    let deflated = miniz_oxide::deflate::compress_to_vec(fields.to_string().as_bytes(), 6);
    let tag = if kind == SignalKind::Offer { OFFER_TAG } else { ANSWER_TAG };
    format!("{tag}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(deflated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields(name: &str) -> Value {
        let fingerprint = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32]);
        let mdns = format!("~{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([1u8; 16]));
        json!(["abcd", "abcdefghijklmnopqrstuv", fingerprint, "a", [[mdns, 5000, 2122260223u32], ["192.168.1.2", 5001, 1]], "p", name])
    }

    #[test]
    fn a_valid_code_gives_its_hello() {
        let hello = Hello { device: DeviceKind::Phone, name: "Ann".into() };
        assert_eq!(decode_signal(&test_code(SignalKind::Offer, &fields("Ann"))), Some((SignalKind::Offer, hello.clone())));
        assert_eq!(decode_signal(&format!(" {} ", test_code(SignalKind::Answer, &fields("Ann")))), Some((SignalKind::Answer, hello)));
    }

    #[test]
    fn damaged_codes_are_refused() {
        assert_eq!(decode_signal(&test_code(SignalKind::Offer, &fields(" Ann"))), None);
        assert_eq!(decode_signal(&test_code(SignalKind::Offer, &json!([1, 2, 3]))), None);
        assert_eq!(decode_signal("T3A1.!!!"), None);
        assert_eq!(decode_signal("T3C1.abc"), None);
    }
}
