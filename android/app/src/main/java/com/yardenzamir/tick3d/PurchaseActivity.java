package com.yardenzamir.tick3d;

import android.app.Activity;
import android.content.Intent;
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
import org.json.JSONObject;
import org.json.JSONException;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Scanner;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

// This activity runs before Chrome. A failed purchase check never blocks offline play.
public class PurchaseActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean opened;
    private Uri destination;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        Uri incoming = getIntent().getData();
        destination = incoming != null && "https".equals(incoming.getScheme()) &&
            getString(R.string.hostName).equals(incoming.getHost()) ? incoming : Uri.parse(getString(R.string.launchUrl));
        // No proof comes from an external intent. Only this activity supplies one.
        Uri.Builder clean = destination.buildUpon().clearQuery();
        for (String key : destination.getQueryParameterNames()) {
            if (!key.equals("playProof") && !key.equals("playReferrer")) {
                for (String value : destination.getQueryParameters(key)) clean.appendQueryParameter(key, value);
            }
        }
        destination = clean.build();
        handler.postDelayed(() -> open(null, null), 60_000);
        new Thread(() -> {
            try {
                String nonce = nonce();
                String token = Tasks.await(IntegrityManagerFactory.create(getApplicationContext()).requestIntegrityToken(
                    IntegrityTokenRequest.builder().setNonce(nonce).build()), 45, TimeUnit.SECONDS).token();
                handler.post(() -> referrer(token));
            } catch (IOException | ExecutionException | TimeoutException error) {
                handler.post(() -> open(null, null));
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                handler.post(() -> open(null, null));
            } catch (JSONException error) {
                throw new IllegalStateException("Invalid purchase nonce answer", error);
            }
        }).start();
    }

    private String nonce() throws IOException, JSONException {
        HttpURLConnection connection = (HttpURLConnection) new URL("https://" + getString(R.string.hostName) + "/api/copies/nonce").openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(5_000);
        connection.setReadTimeout(5_000);
        try (Scanner input = new Scanner(connection.getInputStream(), "UTF-8").useDelimiter("\\A")) {
            return new JSONObject(input.next()).getString("nonce");
        } finally {
            connection.disconnect();
        }
    }

    private void referrer(String token) {
        android.content.SharedPreferences preferences = getSharedPreferences("purchase", MODE_PRIVATE);
        if (preferences.contains("referrer")) {
            open(token, preferences.getString("referrer", ""));
            return;
        }
        InstallReferrerClient client = InstallReferrerClient.newBuilder(this).build();
        Runnable timeout = () -> { client.endConnection(); open(token, null); };
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
                open(token, value);
            }
            @Override public void onInstallReferrerServiceDisconnected() {
                handler.removeCallbacks(timeout);
                client.endConnection();
                open(token, null);
            }
        });
    }

    private void open(String token, String referrer) {
        if (opened || isDestroyed()) return;
        opened = true;
        handler.removeCallbacksAndMessages(null);
        Uri.Builder url = destination.buildUpon();
        if (token != null) url.appendQueryParameter("playProof", token);
        if (referrer != null) url.appendQueryParameter("playReferrer", referrer);
        startActivity(new Intent(this, LauncherActivity.class).setData(url.build()));
        finish();
    }
}
