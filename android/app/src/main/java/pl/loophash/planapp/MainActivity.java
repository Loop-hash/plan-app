package pl.loophash.planapp;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.plugin.WebView;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UpdaterPlugin.class); // aktualizacje jednym przyciskiem
        rollbackBrokenWeb();
        super.onCreate(savedInstanceState);
    }

    /**
     * Nowa wersja strony daje znać (Updater.webReady), że wystartowała. Jeśli dwa uruchomienia
     * z rzędu tego nie zrobiły, wracamy do strony zapisanej w APK, żeby apka nie została zepsuta.
     */
    private void rollbackBrokenWeb() {
        SharedPreferences p = getSharedPreferences(UpdaterPlugin.PREFS, Context.MODE_PRIVATE);
        int pending = p.getInt("pendingWeb", 0);
        if (pending <= 0) return;
        int tries = p.getInt("pendingTries", 0) + 1;
        if (tries >= 2) {
            getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putString(WebView.CAP_SERVER_PATH, "").commit();
            p.edit().remove("pendingWeb").remove("pendingTries").putInt("badWeb", pending).commit();
        } else {
            p.edit().putInt("pendingTries", tries).commit();
        }
    }
}
