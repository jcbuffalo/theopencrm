# Android Build Instructions (TWA)

This directory contains the Trusted Web Activity (TWA) wrapper for deploying the Startingplace web app to Google Play Store.

## Prerequisites

- Java Development Kit (JDK) 11+
- Bubblewrap (auto-installed, but requires Node.js)

## Quick Setup

### 1. Initialize Bubblewrap Project

```bash
cd android
npx @bubblewrap/cli init --manifest https://yourapp.com/manifest.json
```

Respond to prompts:
- Domain: `your-domain.com`
- Package name: `com.yourcompany.appname`
- App name: `Your App Name`
- Theme color: `#16a34a`
- Background color: `#f0fdf4`

### 2. Build APK/AAB

```bash
# Build AAB for Play Store submission
npx @bubblewrap/cli build

# Output files:
# - app-release-bundle.aab (Upload to Play Store)
# - app-release-signed.apk (Test on device)
```

### 3. Upload to Play Store

1. Go to https://play.google.com/console
2. Create app → Select your app
3. Release → Production → Upload `app-release-bundle.aab`
4. Fill in store listing
5. Submit for review (1-7 days)

## ASL Verification

After signing, update `manifest.json` with Digital Asset Links:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.yourcompany.appname",
    "sha256_cert_fingerprints": ["YOUR_SHA256_FINGERPRINT"]
  }
}]
```

Get fingerprint:

```bash
keytool -list -v -keystore android.keystore -alias app
```

Host this in `.well-known/assetlinks.json` on your domain.

## Web Manifest Requirements

Your app needs a `manifest.json` at the root:

```json
{
  "name": "Your App Name",
  "short_name": "App",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#16a34a",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

## Troubleshooting

**Build fails with "Gradle build failed"**
- Clear Gradle cache: `rm -rf ~/.gradle`
- Rebuild: `npx @bubblewrap/cli build`

**APK signs but won't install**
- Check keystore password
- Verify package name matches manifest

**App won't open from Play Store**
- Verify ASL fingerprints match signing key
- Check domain is accessible from Play Store server

## Resources

- [Bubblewrap Documentation](https://github.com/GoogleChromeLabs/bubblewrap)
- [TWA Overview](https://web.dev/articles/using-a-pwa-in-your-android-app)
- [Play Store Testing Guide](https://support.google.com/googleplay/android-developer/)
