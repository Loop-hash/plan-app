package pl.loophash.planapp;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

/**
 * Wynik instalacji nowej wersji (sesja z UpdaterPlugin) i otwarcie apki po aktualizacji.
 *
 * Gdy Android jednak chce zgody (starszy Android albo nakładka producenta), pokazuje jego okienko.
 * Po udanej aktualizacji system zamyka starą wersję i wysyła MY_PACKAGE_REPLACED do nowej:
 * wtedy próbujemy ją otworzyć, o ile aktualizację zaczął przycisk w apce. Android 10+ zwykle to
 * blokuje (sprawdzone na emulatorze z Androidem 15), ale gdzie wolno, apka wróci sama.
 */
public class UpdateReceiver extends BroadcastReceiver {

    static final String ACTION_STATUS = "pl.loophash.planapp.UPDATE_STATUS";
    private static final String TAG = "PlanUpdate";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            Log.i(TAG, "nowa wersja zainstalowana");
            relaunch(ctx);
            return;
        }
        if (!ACTION_STATUS.equals(action)) return;
        int st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        Log.i(TAG, "status " + st + " " + msg);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                : intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    ctx.startActivity(confirm);
                } catch (Exception e) {
                    Log.w(TAG, "okienko instalacji", e);
                }
            }
            UpdaterPlugin.status("confirm", msg);
        } else if (st == PackageInstaller.STATUS_SUCCESS) {
            UpdaterPlugin.status("done", msg);
            relaunch(ctx);
        } else {
            ctx.getSharedPreferences(UpdaterPlugin.PREFS, Context.MODE_PRIVATE).edit().remove("restartAt").apply();
            UpdaterPlugin.status("failed", msg);
        }
    }

    static void relaunch(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(UpdaterPlugin.PREFS, Context.MODE_PRIVATE);
        long at = p.getLong("restartAt", 0);
        if (at == 0 || System.currentTimeMillis() - at > 15 * 60 * 1000L) return;
        p.edit().remove("restartAt").commit();
        Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (launch == null) return;
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            ctx.startActivity(launch);
            Log.i(TAG, "otwieram apkę po aktualizacji");
        } catch (Exception e) {
            Log.w(TAG, "nie udało się otworzyć apki", e);
        }
    }
}
