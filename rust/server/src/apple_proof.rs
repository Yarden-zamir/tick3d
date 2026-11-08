//! iPhone app purchase proofs (the checks of SignedDataVerifier in @apple/app-store-server-library, online mode). A proof is a JWS with an x5c chain: leaf, intermediate, root.
//! The chain must lead to Apple Root CA G3, carry Apple's marker extensions, be in date, and pass OCSP. Every failure
//! refuses the proof (fail closed), also a network fault of the OCSP responder.
//! Speed: a verified chain stays in a cache for 15 minutes, as in the library, so a repeat open costs no OCSP calls.
//! The cache holds only chains that passed every check, and it expires, so revocation reaches the server within 15 minutes.
//! Change from Node: Node tried the production verifier, then the sandbox one, which has no app id check, so a
//! production receipt of another app id passed. Here one chain check runs, and a Production receipt needs APPLE_APP_ID.
//! Certificates: x509-parser (parse and signature checks). OCSP structures: x509-ocsp. No hand-made DER.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use axum::http::StatusCode;
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ring::digest::{SHA1_FOR_LEGACY_USE_ONLY, SHA256, SHA384, digest};
use ring::signature::{self, UnparsedPublicKey, VerificationAlgorithm};
use serde_json::Value;
use x509_cert::der::asn1::OctetString;
use x509_cert::der::{Any, Decode, Encode, oid::ObjectIdentifier};
use x509_cert::serial_number::SerialNumber;
use x509_cert::spki::AlgorithmIdentifierOwned;
use x509_ocsp::{
    BasicOcspResponse, CertId, CertStatus, OcspRequest, OcspResponse, OcspResponseStatus, Request, ResponderId, TbsRequest, Version,
};
use x509_parser::certificate::X509Certificate;
use x509_parser::extensions::{GeneralName, ParsedExtension};
use x509_parser::oid_registry::Oid;
use x509_parser::prelude::FromDer;

use crate::error::{ApiError, ApiResult};

const APPLE_ROOT: &[u8] = include_bytes!("../apple-roots/AppleRootCA-G3.cer");
const MAX_SKEW_MS: i64 = 60_000;
const CACHE_MS: i64 = 15 * 60_000;
const MAX_CACHE: usize = 32;
const LEAF_MARKER: &[u64] = &[1, 2, 840, 113635, 100, 6, 11, 1];
const INTERMEDIATE_MARKER: &[u64] = &[1, 2, 840, 113635, 100, 6, 2, 1];
const OCSP_METHOD: &[u64] = &[1, 3, 6, 1, 5, 5, 7, 48, 1];
const OCSP_BASIC: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.6.1.5.5.7.48.1.1");
const SHA256_OID: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.1");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppleEnvironment {
    Production,
    Sandbox,
}

impl AppleEnvironment {
    pub fn as_str(self) -> &'static str {
        match self {
            AppleEnvironment::Production => "Production",
            AppleEnvironment::Sandbox => "Sandbox",
        }
    }
}

/// A proved purchase. `device` is the App Store id of the phone, which names the device slot.
pub struct ApplePurchase {
    pub app_transaction_id: String,
    pub environment: AppleEnvironment,
    pub device: String,
}

/// Sends an OCSP request to a responder address and returns the answer body.
pub type OcspFetch = Box<dyn Fn(&str, &[u8]) -> Result<Vec<u8>, String> + Send + Sync>;

/// The leaf key of a verified chain and the time when its cache entry expires.
type VerifiedKey = (Vec<u8>, i64);

pub struct AppleProof {
    bundle_id: String,
    app_id: u64,
    root: Vec<u8>,
    fetch: OcspFetch,
    /// The leaf key of a verified chain, by the DER of leaf and intermediate, with the time when it expires.
    verified: Mutex<HashMap<Vec<u8>, VerifiedKey>>,
}

fn refused(message: &str) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, message)
}

fn not_proved() -> ApiError {
    refused("Apple did not prove this app purchase.")
}

fn oid(parts: &[u64]) -> Oid<'static> {
    Oid::from(parts).expect("a valid OID")
}

fn has_extension(cert: &X509Certificate, marker: &[u64]) -> bool {
    let marker = oid(marker);
    cert.extensions().iter().any(|extension| extension.oid == marker)
}

fn in_date(cert: &X509Certificate, now: i64) -> bool {
    let validity = cert.validity();
    validity.not_before.timestamp() * 1000 <= now + MAX_SKEW_MS && validity.not_after.timestamp() * 1000 >= now - MAX_SKEW_MS
}

/// `cert` signed by `issuer`, with the issuer's subject as its issuer.
fn issued_by(cert: &X509Certificate, issuer: &X509Certificate) -> bool {
    cert.issuer().as_raw() == issuer.subject().as_raw() && cert.verify_signature(Some(issuer.public_key())).is_ok()
}

fn parse(der: &[u8]) -> ApiResult<X509Certificate<'_>> {
    match X509Certificate::from_der(der) {
        Ok(([], cert)) => Ok(cert),
        _ => Err(not_proved()),
    }
}

fn ocsp_over_http(url: &str, request: &[u8]) -> Result<Vec<u8>, String> {
    let mut response = ureq::post(url)
        .config()
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .header("Content-Type", "application/ocsp-request")
        .send(request)
        .map_err(|error| error.to_string())?;
    response.body_mut().with_config().limit(1 << 20).read_to_vec().map_err(|error| error.to_string())
}

impl AppleProof {
    /// None when APPLE_BUNDLE_ID and APPLE_APP_ID are both unset. One without the other, or a bad app id, stops the start.
    pub fn from_env() -> Result<Option<AppleProof>, String> {
        let bundle = std::env::var("APPLE_BUNDLE_ID").ok().filter(|text| !text.is_empty());
        let app = std::env::var("APPLE_APP_ID").ok().filter(|text| !text.is_empty());
        let message = "Apple purchase checks need APPLE_BUNDLE_ID and a numeric APPLE_APP_ID";
        let (bundle_id, app) = match (bundle, app) {
            (None, None) => return Ok(None),
            (Some(bundle), Some(app)) => (bundle, app),
            _ => return Err(message.into()),
        };
        let app_id = app.parse::<u64>().ok().filter(|id| *id >= 1).ok_or(message)?;
        parse(APPLE_ROOT).map_err(|_| "the Apple root certificate does not parse".to_owned())?;
        Ok(Some(AppleProof::new(bundle_id, app_id, APPLE_ROOT.to_vec(), Box::new(ocsp_over_http))))
    }

    fn new(bundle_id: String, app_id: u64, root: Vec<u8>, fetch: OcspFetch) -> AppleProof {
        AppleProof { bundle_id, app_id, root, fetch, verified: Mutex::default() }
    }

    /// Checks the proof of an app purchase on the phone `device` (a lower-case UUID) at the time `now`. It blocks on
    /// OCSP: call it from `spawn_blocking`.
    pub fn verify(&self, proof: &str, device: &str, now: i64) -> ApiResult<ApplePurchase> {
        let parts: Vec<&str> = proof.split('.').collect();
        let [header, payload, signature] = parts.as_slice() else { return Err(not_proved()) };
        let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).map_err(|_| not_proved());
        let header_json: Value = serde_json::from_slice(&decode(header)?).map_err(|_| not_proved())?;
        let claims: Value = serde_json::from_slice(&decode(payload)?).map_err(|_| not_proved())?;
        // Apple signs app transactions with ES256: P-256 and SHA-256, with r and s side by side.
        if header_json["alg"] != "ES256" {
            return Err(not_proved());
        }
        let chain = header_json["x5c"].as_array().filter(|chain| chain.len() == 3).ok_or_else(not_proved)?;
        let der = |index: usize| chain[index].as_str().and_then(|text| STANDARD.decode(text).ok()).ok_or_else(not_proved);
        let key = self.verified_key(&der(0)?, &der(1)?, now)?;
        let signed = format!("{header}.{payload}");
        UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, &key)
            .verify(signed.as_bytes(), &decode(signature)?)
            .map_err(|_| not_proved())?;
        self.purchase_of(&claims, device)
    }

    fn purchase_of(&self, claims: &Value, device: &str) -> ApiResult<ApplePurchase> {
        let text = |key: &str| claims[key].as_str();
        let no_identifier = || refused("Apple did not return a purchase identifier for this app.");
        let environment = match text("receiptType") {
            Some("Production") => AppleEnvironment::Production,
            Some("Sandbox") => AppleEnvironment::Sandbox,
            _ => return Err(no_identifier()),
        };
        // TestFlight uses Sandbox, which has no app id. Revisit this exception when the TestFlight link becomes public.
        let app_matches = environment == AppleEnvironment::Sandbox || claims["appAppleId"].as_u64() == Some(self.app_id);
        let id = text("appTransactionId").filter(|id| !id.is_empty());
        let Some(app_transaction_id) = id.filter(|_| text("bundleId") == Some(self.bundle_id.as_str()) && app_matches) else {
            return Err(no_identifier());
        };
        // Apple's check: SHA-384 of the lower-case nonce and the lower-case device id, in Base64. A copied proof carries
        // the hash of the phone that it came from, so it works only with that phone's id.
        let (Some(hash), Some(nonce)) = (text("deviceVerification"), text("deviceVerificationNonce")) else {
            return Err(refused("Apple did not tie this app purchase to a device."));
        };
        let expected = STANDARD.encode(digest(&SHA384, format!("{}{device}", nonce.to_lowercase()).as_bytes()));
        if expected != hash {
            return Err(refused("This app purchase belongs to another device."));
        }
        Ok(ApplePurchase { app_transaction_id: app_transaction_id.to_owned(), environment, device: device.to_owned() })
    }

    /// The leaf public key of a chain that leads to the root, from the cache or from a full check.
    fn verified_key(&self, leaf_der: &[u8], intermediate_der: &[u8], now: i64) -> ApiResult<Vec<u8>> {
        let cache_key = [leaf_der, intermediate_der].concat();
        if let Some((key, expires)) = self.verified.lock().expect("the chain cache is not poisoned").get(&cache_key)
            && *expires > now
        {
            return Ok(key.clone());
        }
        let (leaf, intermediate, root) = (parse(leaf_der)?, parse(intermediate_der)?, parse(&self.root)?);
        let valid = issued_by(&intermediate, &root)
            && issued_by(&leaf, &intermediate)
            && intermediate.is_ca()
            && has_extension(&leaf, LEAF_MARKER)
            && has_extension(&intermediate, INTERMEDIATE_MARKER)
            && [&leaf, &intermediate, &root].iter().all(|cert| in_date(cert, now));
        if !valid {
            return Err(not_proved());
        }
        self.check_ocsp(&leaf, &intermediate, now)?;
        self.check_ocsp(&intermediate, &root, now)?;
        let key = leaf.public_key().subject_public_key.data.to_vec();
        let mut cache = self.verified.lock().expect("the chain cache is not poisoned");
        cache.retain(|_, (_, expires)| *expires > now);
        if cache.len() < MAX_CACHE {
            cache.insert(cache_key, (key.clone(), now + CACHE_MS));
        }
        Ok(key)
    }

    /// OCSP for `cert`: the responder must answer "good", in date, in a response signed by the issuer, or by a responder
    /// certificate that the issuer signed for OCSP signing.
    fn check_ocsp(&self, cert: &X509Certificate, issuer: &X509Certificate, now: i64) -> ApiResult<()> {
        let url = ocsp_url(cert).ok_or_else(not_proved)?;
        let id = cert_id(cert, issuer)?;
        let request = OcspRequest {
            tbs_request: TbsRequest {
                version: Version::V1,
                requestor_name: None,
                request_list: vec![Request { req_cert: id.clone(), single_request_extensions: None }],
                request_extensions: None,
            },
            optional_signature: None,
        }
        .to_der()
        .map_err(ApiError::fault)?;
        let response = (self.fetch)(&url, &request).map_err(|error| {
            eprintln!("apple ocsp: {error}");
            ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "Apple could not check the purchase. Open the app again later.")
        })?;
        ocsp_good(&response, &id, issuer, now).ok_or_else(not_proved)
    }
}

fn ocsp_url(cert: &X509Certificate) -> Option<String> {
    let method = oid(OCSP_METHOD);
    cert.extensions().iter().find_map(|extension| match extension.parsed_extension() {
        ParsedExtension::AuthorityInfoAccess(access) => access.accessdescs.iter().find_map(|entry| match &entry.access_location {
            GeneralName::URI(uri) if entry.access_method == method => Some((*uri).to_owned()),
            _ => None,
        }),
        _ => None,
    })
}

/// The CertID of `cert` with SHA-256, as the request names it and the response must repeat it.
fn cert_id(cert: &X509Certificate, issuer: &X509Certificate) -> ApiResult<CertId> {
    let octets = |bytes: &[u8]| OctetString::new(bytes).map_err(ApiError::fault);
    Ok(CertId {
        hash_algorithm: AlgorithmIdentifierOwned { oid: SHA256_OID, parameters: Some(Any::null()) },
        issuer_name_hash: octets(digest(&SHA256, issuer.subject().as_raw()).as_ref())?,
        issuer_key_hash: octets(digest(&SHA256, &issuer.public_key().subject_public_key.data).as_ref())?,
        serial_number: SerialNumber::new(cert.tbs_certificate.raw_serial()).map_err(ApiError::fault)?,
    })
}

/// The same certificate: the hash algorithm, both hashes and the serial. The parameters of the hash do not count.
fn same_cert(found: &CertId, asked: &CertId) -> bool {
    found.hash_algorithm.oid == asked.hash_algorithm.oid
        && found.issuer_name_hash == asked.issuer_name_hash
        && found.issuer_key_hash == asked.issuer_key_hash
        && found.serial_number == asked.serial_number
}

/// The verification algorithm for a signature algorithm and the signer's key. Only SHA-256, SHA-384 and SHA-512, as in
/// the library.
fn algorithm_for(signature_oid: &str, signer: &X509Certificate) -> Option<&'static dyn VerificationAlgorithm> {
    let key = signer.public_key();
    let curve = key.algorithm.parameters.as_ref().and_then(|parameters| parameters.as_oid().ok()).map(|oid| oid.to_id_string());
    Some(match (signature_oid, curve.as_deref()) {
        ("1.2.840.10045.4.3.2", Some("1.2.840.10045.3.1.7")) => &signature::ECDSA_P256_SHA256_ASN1,
        ("1.2.840.10045.4.3.3", Some("1.2.840.10045.3.1.7")) => &signature::ECDSA_P256_SHA384_ASN1,
        ("1.2.840.10045.4.3.2", Some("1.3.132.0.34")) => &signature::ECDSA_P384_SHA256_ASN1,
        ("1.2.840.10045.4.3.3", Some("1.3.132.0.34")) => &signature::ECDSA_P384_SHA384_ASN1,
        ("1.2.840.113549.1.1.11", _) => &signature::RSA_PKCS1_2048_8192_SHA256,
        ("1.2.840.113549.1.1.12", _) => &signature::RSA_PKCS1_2048_8192_SHA384,
        ("1.2.840.113549.1.1.13", _) => &signature::RSA_PKCS1_2048_8192_SHA512,
        _ => return None,
    })
}

fn millis(time: &x509_ocsp::OcspGeneralizedTime) -> Option<i64> {
    i64::try_from(time.0.to_unix_duration().as_millis()).ok()
}

/// Some(()) only for a well-formed, correctly signed, fresh "good" answer about `id`.
fn ocsp_good(response: &[u8], id: &CertId, issuer: &X509Certificate, now: i64) -> Option<()> {
    let response = OcspResponse::from_der(response).ok()?;
    let bytes = response.response_bytes.filter(|_| response.response_status == OcspResponseStatus::Successful)?;
    if bytes.response_type != OCSP_BASIC {
        return None;
    }
    let basic = BasicOcspResponse::from_der(bytes.response.as_bytes()).ok()?;
    let extra_der: Vec<Vec<u8>> = basic.certs.iter().flatten().filter_map(|cert| cert.to_der().ok()).collect();
    let extra: Vec<X509Certificate> = extra_der.iter().filter_map(|der| parse(der).ok()).collect();
    let data = &basic.tbs_response_data;
    let signer = std::iter::once(issuer).chain(extra.iter()).find(|cert| match &data.responder_id {
        ResponderId::ByKey(hash) => {
            hash.as_bytes() == digest(&SHA1_FOR_LEGACY_USE_ONLY, &cert.public_key().subject_public_key.data).as_ref()
        }
        ResponderId::ByName(name) => name.to_der().is_ok_and(|name| name == cert.subject().as_raw()),
    })?;
    let delegated = !std::ptr::eq(signer, issuer);
    if delegated {
        let for_ocsp = signer.extended_key_usage().ok().flatten().is_some_and(|usage| usage.value.ocsp_signing);
        if !(issued_by(signer, issuer) && in_date(signer, now) && for_ocsp) {
            return None;
        }
    }
    let algorithm = algorithm_for(&basic.signature_algorithm.oid.to_string(), signer)?;
    let signed = data.to_der().ok()?;
    UnparsedPublicKey::new(algorithm, &signer.public_key().subject_public_key.data).verify(&signed, basic.signature.as_bytes()?).ok()?;
    let single = data.responses.iter().find(|single| same_cert(&single.cert_id, id))?;
    let issued = millis(&single.this_update)?;
    // A missing nextUpdate passes, as in the library.
    let fresh = issued <= now + MAX_SKEW_MS
        && single.next_update.as_ref().is_none_or(|next| millis(next).is_some_and(|next| next >= now - MAX_SKEW_MS));
    (matches!(single.cert_status, CertStatus::Good(_)) && fresh).then_some(())
}

#[cfg(test)]
mod tests;
