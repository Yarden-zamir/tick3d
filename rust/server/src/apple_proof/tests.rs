//! Adversarial tests of the Apple proof check, on a test PKI that rcgen makes and OCSP answers that x509-ocsp encodes.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rcgen::{BasicConstraints, CertificateParams, CustomExtension, DnType, IsCa, Issuer, KeyPair, PKCS_ECDSA_P256_SHA256, date_time_ymd};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_ASN1_SIGNING, ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair};
use x509_cert::der::asn1::{BitString, GeneralizedTime};
use x509_ocsp::{OcspGeneralizedTime, ResponseBytes, ResponseData, RevokedInfo, SingleResponse};

use super::*;

/// 2026-11-03 12:00 UTC.
const NOW: i64 = 1_793_707_200_000;
const DEVICE: &str = "11111111-2222-3333-4444-555555555555";
const NONCE: &str = "ABCDEF00-0000-0000-0000-000000000000";
const BUNDLE: &str = "com.example.app";
const APP_ID: u64 = 42;
const ECDSA_SHA256: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.4.3.2");

/// What the test OCSP responder answers.
#[derive(Clone, Copy, PartialEq)]
enum Answer {
    Good,
    Revoked,
    Unknown,
    /// nextUpdate an hour before now.
    Stale,
    /// thisUpdate an hour after now.
    Future,
    /// Signed by a key that is not the issuer's.
    WrongSigner,
    Malformed,
    /// responseStatus tryLater.
    TryLater,
    Offline,
}

struct Pki {
    root: Vec<u8>,
    intermediate: Vec<u8>,
    leaf: Vec<u8>,
    root_key: KeyPair,
    intermediate_key: KeyPair,
    leaf_key: KeyPair,
}

fn aia(url: &str) -> CustomExtension {
    // AuthorityInfoAccessSyntax: SEQUENCE OF { id-ad-ocsp, [6] URI }.
    let method = [0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x01];
    let mut location = vec![0x86, url.len() as u8];
    location.extend_from_slice(url.as_bytes());
    let mut description = vec![0x30, (method.len() + location.len()) as u8];
    description.extend_from_slice(&method);
    description.extend_from_slice(&location);
    let mut content = vec![0x30, description.len() as u8];
    content.extend_from_slice(&description);
    CustomExtension::from_oid_content(&[1, 3, 6, 1, 5, 5, 7, 1, 1], content)
}

fn marker(parts: &[u64]) -> CustomExtension {
    CustomExtension::from_oid_content(parts, vec![0x05, 0x00])
}

fn params(name: &str, ca: bool, extensions: Vec<CustomExtension>) -> CertificateParams {
    let mut params = CertificateParams::new(Vec::<String>::new()).expect("params");
    params.distinguished_name.push(DnType::CommonName, name);
    params.is_ca = if ca { IsCa::Ca(BasicConstraints::Unconstrained) } else { IsCa::NoCa };
    params.not_before = date_time_ymd(2025, 1, 1);
    params.not_after = date_time_ymd(2030, 1, 1);
    params.custom_extensions = extensions;
    params
}

/// A chain like Apple's. `edit_leaf` changes the leaf parameters for a negative case.
fn pki(edit_leaf: impl FnOnce(&mut CertificateParams)) -> Pki {
    let key = || KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("a key");
    let (root_key, intermediate_key, leaf_key) = (key(), key(), key());
    let root_params = params("Test Root", true, vec![]);
    let root = root_params.self_signed(&root_key).expect("root");
    let intermediate_params = params("Test Intermediate", true, vec![marker(INTERMEDIATE_MARKER), aia("http://ocsp.test/root")]);
    let intermediate =
        intermediate_params.signed_by(&intermediate_key, &Issuer::from_params(&root_params, &root_key)).expect("intermediate");
    let mut leaf_params = params("Test Leaf", false, vec![marker(LEAF_MARKER), aia("http://ocsp.test/intermediate")]);
    edit_leaf(&mut leaf_params);
    let leaf = leaf_params.signed_by(&leaf_key, &Issuer::from_params(&intermediate_params, &intermediate_key)).expect("leaf");
    Pki {
        root: root.der().to_vec(),
        intermediate: intermediate.der().to_vec(),
        leaf: leaf.der().to_vec(),
        root_key,
        intermediate_key,
        leaf_key,
    }
}

fn time(at: i64) -> OcspGeneralizedTime {
    OcspGeneralizedTime(GeneralizedTime::from_unix_duration(Duration::from_millis(at as u64)).expect("a time"))
}

fn sign_asn1(key: &KeyPair, data: &[u8]) -> Vec<u8> {
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &key.serialize_der(), &SystemRandom::new()).expect("a key pair");
    pair.sign(&SystemRandom::new(), data).expect("a signature").as_ref().to_vec()
}

/// The OCSP answer of the issuer for the certificate that `request` asks about.
fn ocsp_answer(answer: Answer, request: &[u8], issuer: &[u8], issuer_key: &KeyPair, stranger: &KeyPair) -> Result<Vec<u8>, String> {
    match answer {
        Answer::Offline => return Err("offline".into()),
        Answer::Malformed => return Ok(vec![0x30, 0x03, 0x0a, 0x01]),
        Answer::TryLater => {
            return Ok(OcspResponse { response_status: OcspResponseStatus::TryLater, response_bytes: None }.to_der().expect("der"));
        }
        _ => {}
    }
    let request = OcspRequest::from_der(request).expect("the server sends a valid request");
    let cert_id = request.tbs_request.request_list[0].req_cert.clone();
    let issuer = parse(issuer).expect("issuer");
    let key_hash =
        OctetString::new(digest(&SHA1_FOR_LEGACY_USE_ONLY, &issuer.public_key().subject_public_key.data).as_ref()).expect("hash");
    let cert_status = match answer {
        Answer::Revoked => CertStatus::Revoked(RevokedInfo { revocation_time: time(NOW - 86_400_000), revocation_reason: None }),
        Answer::Unknown => CertStatus::unknown(),
        _ => CertStatus::good(),
    };
    let (this_update, next_update) = match answer {
        Answer::Stale => (NOW - 7_200_000, NOW - 3_600_000),
        Answer::Future => (NOW + 3_600_000, NOW + 7_200_000),
        _ => (NOW - 60_000, NOW + 3_600_000),
    };
    let data = ResponseData {
        version: Version::V1,
        responder_id: ResponderId::ByKey(key_hash),
        produced_at: time(NOW),
        responses: vec![SingleResponse {
            cert_id,
            cert_status,
            this_update: time(this_update),
            next_update: Some(time(next_update)),
            single_extensions: None,
        }],
        response_extensions: None,
    };
    let signer = if answer == Answer::WrongSigner { stranger } else { issuer_key };
    let signature = sign_asn1(signer, &data.to_der().expect("der"));
    let basic = BasicOcspResponse {
        tbs_response_data: data,
        signature_algorithm: AlgorithmIdentifierOwned { oid: ECDSA_SHA256, parameters: None },
        signature: BitString::from_bytes(&signature).expect("bits"),
        certs: None,
    };
    let bytes = ResponseBytes { response_type: OCSP_BASIC, response: OctetString::new(basic.to_der().expect("der")).expect("octets") };
    Ok(OcspResponse { response_status: OcspResponseStatus::Successful, response_bytes: Some(bytes) }.to_der().expect("der"))
}

/// A checker that trusts the test root, and its OCSP call count. `answers` sets the answer for (leaf, intermediate).
fn checker(pki: &Pki, answers: Arc<Mutex<(Answer, Answer)>>) -> (AppleProof, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let (root, intermediate) = (pki.root.clone(), pki.intermediate.clone());
    let keys = [pki.root_key.serialize_der(), pki.intermediate_key.serialize_der()];
    let fetch: OcspFetch = Box::new(move |url, request| {
        counted.fetch_add(1, Ordering::SeqCst);
        let stranger = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("a key");
        let key = |index: usize| KeyPair::try_from(keys[index].as_slice()).expect("a key");
        let (leaf_answer, intermediate_answer) = *answers.lock().expect("answers");
        match url {
            "http://ocsp.test/intermediate" => ocsp_answer(leaf_answer, request, &intermediate, &key(1), &stranger),
            "http://ocsp.test/root" => ocsp_answer(intermediate_answer, request, &root, &key(0), &stranger),
            other => Err(format!("unknown responder {other}")),
        }
    });
    (AppleProof::new(BUNDLE.into(), APP_ID, pki.root.clone(), fetch), calls)
}

fn claims(receipt: &str, app_id: u64, bundle: &str) -> Value {
    let hash = STANDARD.encode(digest(&SHA384, format!("{}{DEVICE}", NONCE.to_lowercase()).as_bytes()));
    serde_json::json!({ "receiptType": receipt, "bundleId": bundle, "appAppleId": app_id, "appTransactionId": "2000000123",
        "deviceVerification": hash, "deviceVerificationNonce": NONCE })
}

fn jws(pki: &Pki, alg: &str, claims: &Value) -> String {
    let chain: Vec<String> = [&pki.leaf, &pki.intermediate, &pki.root].iter().map(|der| STANDARD.encode(der)).collect();
    let header = URL_SAFE_NO_PAD.encode(serde_json::json!({ "alg": alg, "x5c": chain }).to_string());
    let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &pki.leaf_key.serialize_der(), &SystemRandom::new())
        .expect("a key pair");
    let signature = pair.sign(&SystemRandom::new(), format!("{header}.{payload}").as_bytes()).expect("a signature");
    format!("{header}.{payload}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
}

fn good() -> Arc<Mutex<(Answer, Answer)>> {
    Arc::new(Mutex::new((Answer::Good, Answer::Good)))
}

fn status(result: ApiResult<ApplePurchase>) -> Option<StatusCode> {
    match result {
        Ok(_) => None,
        Err(ApiError::Refusal { status, .. }) => Some(status),
        Err(other) => panic!("a fault, not a refusal: {other:?}"),
    }
}

#[test]
fn accepts_a_valid_proof_and_caches_the_chain_for_15_minutes() {
    let pki = pki(|_| {});
    let (proof, calls) = checker(&pki, good());
    let token = jws(&pki, "ES256", &claims("Production", APP_ID, BUNDLE));
    let purchase = proof.verify(&token, DEVICE, NOW).expect("a valid proof");
    assert_eq!((purchase.app_transaction_id.as_str(), purchase.environment), ("2000000123", AppleEnvironment::Production));
    assert_eq!(calls.load(Ordering::SeqCst), 2, "one OCSP call per certificate");
    proof.verify(&token, DEVICE, NOW + 60_000).expect("a cached chain");
    assert_eq!(calls.load(Ordering::SeqCst), 2, "the cache answers within 15 minutes");
    proof.verify(&token, DEVICE, NOW + CACHE_MS + 1).expect("a checked chain");
    assert_eq!(calls.load(Ordering::SeqCst), 4, "an expired cache entry checks OCSP again");
}

#[test]
fn checks_identity_after_the_signature() {
    let pki = pki(|_| {});
    let (proof, _) = checker(&pki, good());
    let refused = |claims: Value, device: &str| status(proof.verify(&jws(&pki, "ES256", &claims), device, NOW));
    assert_eq!(refused(claims("Sandbox", 0, BUNDLE), DEVICE), None, "TestFlight has no app id");
    assert_eq!(refused(claims("Production", APP_ID + 1, BUNDLE), DEVICE), Some(StatusCode::FORBIDDEN), "Production needs our app id");
    assert_eq!(refused(claims("Production", APP_ID, "com.other"), DEVICE), Some(StatusCode::FORBIDDEN));
    assert_eq!(refused(claims("Xcode", APP_ID, BUNDLE), DEVICE), Some(StatusCode::FORBIDDEN));
    assert_eq!(refused(claims("Production", APP_ID, BUNDLE), "99999999-2222-3333-4444-555555555555"), Some(StatusCode::FORBIDDEN));
    let mut no_device = claims("Production", APP_ID, BUNDLE);
    no_device.as_object_mut().expect("an object").remove("deviceVerification");
    assert_eq!(refused(no_device, DEVICE), Some(StatusCode::FORBIDDEN));
}

#[test]
fn refuses_a_bad_signature_or_algorithm() {
    let pki = pki(|_| {});
    let (proof, _) = checker(&pki, good());
    let token = jws(&pki, "ES256", &claims("Production", APP_ID, BUNDLE));
    let (signed, signature) = token.rsplit_once('.').expect("three parts");
    // Another payload under the old signature.
    let (header, _) = signed.split_once('.').expect("two parts");
    let forged = format!("{header}.{}.{signature}", URL_SAFE_NO_PAD.encode(claims("Production", APP_ID, "com.other").to_string()));
    assert_eq!(status(proof.verify(&forged, DEVICE, NOW)), Some(StatusCode::FORBIDDEN));
    assert_eq!(status(proof.verify(&jws(&pki, "none", &claims("Production", APP_ID, BUNDLE)), DEVICE, NOW)), Some(StatusCode::FORBIDDEN));
    assert_eq!(status(proof.verify("not.a.jws", DEVICE, NOW)), Some(StatusCode::FORBIDDEN));
    assert_eq!(status(proof.verify("two.parts", DEVICE, NOW)), Some(StatusCode::FORBIDDEN));
}

#[test]
fn refuses_a_chain_to_another_root_or_without_markers_or_out_of_date() {
    let pki_a = pki(|_| {});
    let pki_b = pki(|_| {});
    let (trusts_a, _) = checker(&pki_a, good());
    let token_b = jws(&pki_b, "ES256", &claims("Production", APP_ID, BUNDLE));
    assert_eq!(status(trusts_a.verify(&token_b, DEVICE, NOW)), Some(StatusCode::FORBIDDEN), "another root");

    let unmarked = pki(|params| params.custom_extensions.retain(|extension| extension.oid_components().collect::<Vec<_>>() != LEAF_MARKER));
    let (proof, calls) = checker(&unmarked, good());
    assert_eq!(
        status(proof.verify(&jws(&unmarked, "ES256", &claims("Production", APP_ID, BUNDLE)), DEVICE, NOW)),
        Some(StatusCode::FORBIDDEN)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0, "no OCSP for a chain that fails offline checks");

    let expired = pki(|params| params.not_after = date_time_ymd(2026, 1, 1));
    let (proof, _) = checker(&expired, good());
    assert_eq!(
        status(proof.verify(&jws(&expired, "ES256", &claims("Production", APP_ID, BUNDLE)), DEVICE, NOW)),
        Some(StatusCode::FORBIDDEN)
    );

    let not_yet = pki(|params| params.not_before = date_time_ymd(2027, 1, 1));
    let (proof, _) = checker(&not_yet, good());
    assert_eq!(
        status(proof.verify(&jws(&not_yet, "ES256", &claims("Production", APP_ID, BUNDLE)), DEVICE, NOW)),
        Some(StatusCode::FORBIDDEN)
    );
}

#[test]
fn fails_closed_on_every_bad_ocsp_answer_and_caches_no_failure() {
    let pki = pki(|_| {});
    let token = jws(&pki, "ES256", &claims("Production", APP_ID, BUNDLE));
    let bad = [Answer::Revoked, Answer::Unknown, Answer::Stale, Answer::Future, Answer::WrongSigner, Answer::Malformed, Answer::TryLater];
    for answer in bad {
        for (leaf, intermediate) in [(answer, Answer::Good), (Answer::Good, answer)] {
            let answers = Arc::new(Mutex::new((leaf, intermediate)));
            let (proof, calls) = checker(&pki, answers.clone());
            assert_eq!(status(proof.verify(&token, DEVICE, NOW)), Some(StatusCode::FORBIDDEN), "leaf and intermediate answers");
            // The refusal left no cache entry: the next try checks OCSP again, and passes once the answer is good.
            let before = calls.load(Ordering::SeqCst);
            *answers.lock().expect("answers") = (Answer::Good, Answer::Good);
            proof.verify(&token, DEVICE, NOW).expect("a good answer now");
            assert!(calls.load(Ordering::SeqCst) > before);
        }
    }
    let (offline, _) = checker(&pki, Arc::new(Mutex::new((Answer::Offline, Answer::Good))));
    assert_eq!(status(offline.verify(&token, DEVICE, NOW)), Some(StatusCode::SERVICE_UNAVAILABLE), "no proof passes without OCSP");
}

#[test]
fn reads_the_real_apple_root() {
    let root = parse(APPLE_ROOT).expect("the Apple root parses");
    assert!(root.is_ca());
    assert!(issued_by(&root, &root), "the root signs itself");
}
