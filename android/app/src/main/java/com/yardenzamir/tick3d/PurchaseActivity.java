package com.yardenzamir.tick3d;

import android.app.Activity;
import android.content.Intent;
import android.content.ComponentName;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.RemoteException;
import com.android.installreferrer.api.InstallReferrerClient;
import com.android.installreferrer.api.InstallReferrerStateListener;
import com.google.android.gms.tasks.Tasks;
import com.google.android.play.core.integrity.IntegrityManagerFactory;
import com.google.android.play.core.integrity.IntegrityTokenRequest;
import androidx.browser.customtabs.CustomTabsCallback;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsServiceConnection;
import androidx.browser.customtabs.CustomTabsSession;
import androidx.browser.trusted.TrustedWebActivityIntentBuilder;
import org.json.JSONObject;
import org.json.JSONException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

// Chrome owns the player token. Its validated message channel supplies the player's server nonce.
public class PurchaseActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean launched;
    private boolean requested;
    private boolean bound;
    private CustomTabsSession session;
    private Uri destination;
    private Uri origin;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        Uri incoming = getIntent().getData();
        destination = incoming != null && "https".equals(incoming.getScheme()) &&
            getString(R.string.hostName).equals(incoming.getHost()) ? incoming : Uri.parse(getString(R.string.launchUrl));
        // No proof comes from an external intent. Only this activity supplies one.
        Uri.Builder clean = destination.buildUpon().clearQuery();
        for (String key : destination.getQueryParameterNames()) {
            if (!key.equals("playProof") && !key.equals("playReferrer") && !key.equals("playPurchase")) {
                for (String value : destination.getQueryParameters(key)) clean.appendQueryParameter(key, value);
            }
        }
        destination = clean.build();
        origin = Uri.parse("https://" + getString(R.string.hostName));
        // A slow or offline check never holds the game behind a purchase screen.
        handler.postDelayed(this::fallback, 5_000);
        String browser = CustomTabsClient.getPackageName(this, null);
        if (browser == null) {
            fallback();
            return;
        }
        bound = CustomTabsClient.bindCustomTabsService(this, browser, connection);
        if (!bound) fallback();
    }

    private final CustomTabsServiceConnection connection = new CustomTabsServiceConnection() {
        @Override public void onCustomTabsServiceConnected(ComponentName name, CustomTabsClient client) {
            if (isFinishing() || isDestroyed()) return;
            client.warmup(0L);
            session = client.newSession(callback);
            if (session == null) {
                fallback();
                return;
            }
            handler.removeCallbacksAndMessages(null);
            launched = true;
            new TrustedWebActivityIntentBuilder(destination.buildUpon().appendQueryParameter("playPurchase", "1").build())
                .build(session).launchTrustedWebActivity(PurchaseActivity.this);
            handler.postDelayed(() -> finish(), 60_000);
        }
        @Override public void onServiceDisconnected(ComponentName name) { fallback(); }
    };

    private final CustomTabsCallback callback = new CustomTabsCallback() {
        @Override public void onNavigationEvent(int event, Bundle extras) {
            if (event == NAVIGATION_FINISHED && !requested && session != null) {
                // Chrome validates use_as_origin and sends only to our own site, never a later external page.
                session.requestPostMessageChannel(origin, origin, new Bundle());
            }
        }
        @Override public void onMessageChannelReady(Bundle extras) {
            session.postMessage("tick3d.purchase", null);
        }
        @Override public void onPostMessage(String message, Bundle extras) {
            if (requested) {
                if (message.equals("done")) finish();
                return;
            }
            requested = true;
            prove(message);
        }
    };

    private void prove(String nonce) {
        new Thread(() -> {
            try {
                String token = Tasks.await(IntegrityManagerFactory.create(getApplicationContext()).requestIntegrityToken(
                    IntegrityTokenRequest.builder().setNonce(nonce).build()), 45, TimeUnit.SECONDS).token();
                handler.post(() -> referrer(token));
            } catch (ExecutionException | TimeoutException error) {
                handler.post(() -> finish());
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                handler.post(() -> finish());
            }
        }).start();
    }

    private void referrer(String token) {
        android.content.SharedPreferences preferences = getSharedPreferences("purchase", MODE_PRIVATE);
        if (preferences.contains("referrer")) {
            deliver(token, preferences.getString("referrer", ""));
            return;
        }
        InstallReferrerClient client = InstallReferrerClient.newBuilder(this).build();
        Runnable timeout = () -> { client.endConnection(); deliver(token, null); };
        handler.postDelayed(timeout, 3_000);
        client.startConnection(new InstallReferrerStateListener() {
            @Override public void onInstallReferrerSetupFinished(int response) {
                handler.removeCallbacks(timeout);
                String value = null;
                try {
                    if (response == InstallReferrerClient.InstallReferrerResponse.OK) {
                        value = client.getInstallReferrer().getInstallReferrer();
                        preferences.edit().putString("referrer", value).apply();
                    }
                } catch (RemoteException error) {
                    // The next launch retries a disconnected Play Store.
                } finally {
                    client.endConnection();
                }
                deliver(token, value);
            }
            @Override public void onInstallReferrerServiceDisconnected() {
                handler.removeCallbacks(timeout);
                client.endConnection();
                deliver(token, null);
            }
        });
    }

    private void deliver(String token, String referrer) {
        if (isFinishing() || isDestroyed() || session == null) return;
        try {
            JSONObject answer = new JSONObject().put("proof", token).put("referrer", referrer == null ? JSONObject.NULL : referrer);
            session.postMessage(answer.toString(), null);
        } catch (JSONException error) {
            throw new IllegalStateException("Cannot encode the Play purchase answer", error);
        }
    }

    private void fallback() {
        if (isFinishing() || isDestroyed()) return;
        if (!launched) startActivity(new Intent(this, LauncherActivity.class).setData(destination));
        finish();
    }

    @Override protected void onRestart() {
        super.onRestart();
        if (launched) finish();
    }

    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (bound) unbindService(connection);
        super.onDestroy();
    }
}
