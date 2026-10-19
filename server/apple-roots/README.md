# Apple trust root

`AppleRootCA-G3.cer` comes from https://www.apple.com/certificateauthority/AppleRootCA-G3.cer.
The App Store Server Library verifies the signed transaction chain against this root, with online revocation checks.
Do not trust a root supplied by the page or by the signed transaction itself.
