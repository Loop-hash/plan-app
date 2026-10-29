package pl.loophash.planapp;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.plugin.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Aktualizacje jednym przyciskiem.
 *
 * Zwykle zmienia się tylko strona apki (JS, CSS): wtedy apka pobiera paczkę ze stroną (plan-www.zip),
 * rozpakowuje ją do swojej pamięci i przeładowuje się na nią. Nic się nie instaluje, więc Android
 * o nic nie pyta. (Przeniesione z Do Pierwszego.)
 *
 * Gdy zmieniła się część androidowa, pobiera całe APK i instaluje je sesją PackageInstaller.
 * Od Androida 12 apka może tak zaktualizować samą siebie bez okienka z pytaniem. Po instalacji
 * Android zamyka apkę; UpdateReceiver próbuje ją otworzyć, ale nowe Androidy na to nie pozwalają
 * (blokada otwierania z tła), więc zwykle trzeba dotknąć ikonki.
 *
 * Gdyby nowa strona nie wystartowała dwa razy z rzędu, MainActivity wraca do wersji z APK.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    static final String PREFS = "PlanUpdater";
    private static UpdaterPlugin live;

    @Override
    public void load() {
        live = this;
    }

    /** Wiadomość o stanie instalacji APK dla strony (z UpdateReceiver). */
    static void status(String state, String message) {
        UpdaterPlugin p = live;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("state", state);
        o.put("message", message == null ? "" : message);
        p.notifyListeners("status", o);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private File cacheDir() {
        File dir = new File(getContext().getCacheDir(), "aktualizacja");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private File webRoot() {
        return new File(getContext().getFilesDir(), "web");
    }

    // ---------- informacje ----------

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        JSONObject b = readAssetJson("public/build.json");
        r.put("native", b.optString("native", ""));
        r.put("apkBuild", b.optInt("build", 0));
        String cur = bridge.getServerBasePath();
        r.put("webPath", cur != null && cur.startsWith("/") ? cur : "");
        r.put("badWeb", prefs().getInt("badWeb", 0));
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("silent", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S);
        call.resolve(r);
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        boolean ok = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || getContext().getPackageManager().canRequestPackageInstalls();
        r.put("allowed", ok);
        call.resolve(r);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Nie udało się otworzyć ustawień");
        }
    }

    // ---------- aktualizacja strony ----------

    @PluginMethod
    public void applyWeb(PluginCall call) {
        final String url = call.getString("url");
        final long size = longOf(call.getLong("size"));
        final Integer buildObj = call.getInt("build");
        if (url == null || url.isEmpty() || buildObj == null) {
            call.reject("Brak adresu aktualizacji");
            return;
        }
        final int build = buildObj;
        new Thread(() -> {
            File root = webRoot();
            root.mkdirs();
            File dir = new File(root, "b" + build);
            File tmp = new File(root, "b" + build + ".tmp");
            File zip = new File(cacheDir(), "www.zip");
            try {
                deleteRec(tmp);
                tmp.mkdirs();
                download(url, size, zip, "web");
                unzip(zip, tmp);
                zip.delete();
                String cur = bridge.getServerBasePath();
                boolean curIsFile = cur != null && cur.startsWith("/");
                if (!new File(tmp, "index.html").exists() || !new File(tmp, "app.js").exists()) {
                    throw new Exception("niepełna paczka");
                }
                deleteRec(dir);
                if (!tmp.renameTo(dir)) throw new Exception("nie udało się zapisać plików");

                final String path = dir.getAbsolutePath();
                final String prev = curIsFile ? cur : "";
                prefs().edit().putInt("pendingWeb", build).putInt("pendingTries", 0).commit();
                getContext().getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Context.MODE_PRIVATE)
                    .edit().putString(WebView.CAP_SERVER_PATH, path).commit();
                call.resolve();
                // chwila na zapisanie danych przez stronę, potem przeładowanie na nową wersję
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    try {
                        bridge.getWebView().clearCache(true);
                    } catch (Exception ignored) {
                        // bez czyszczenia też zadziała
                    }
                    bridge.setServerBasePath(path);
                }, 600);
                // nowa strona nie dała znaku życia: od razu wracamy do poprzedniej
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    if (prefs().getInt("pendingWeb", 0) != build) return;
                    prefs().edit().remove("pendingWeb").remove("pendingTries").putInt("badWeb", build).commit();
                    getContext().getSharedPreferences(WebView.WEBVIEW_PREFS_NAME, Context.MODE_PRIVATE)
                        .edit().putString(WebView.CAP_SERVER_PATH, prev).commit();
                    if (prev.isEmpty()) bridge.setServerAssetPath("public");
                    else bridge.setServerBasePath(prev);
                }, 30000);
            } catch (Exception e) {
                deleteRec(tmp);
                zip.delete();
                call.reject("Nie udało się pobrać aktualizacji: " + e.getMessage());
            }
        }).start();
    }

    /** Strona wystartowała: nowa wersja jest dobra, stare paczki można skasować. */
    @PluginMethod
    public void webReady(PluginCall call) {
        prefs().edit().remove("pendingWeb").remove("pendingTries").apply();
        final String cur = bridge.getServerBasePath();
        new Thread(() -> {
            File[] list = webRoot().listFiles();
            if (list == null) return;
            for (File f : list) {
                if (cur == null || !f.getAbsolutePath().equals(cur)) deleteRec(f);
            }
        }).start();
        call.resolve();
    }

    // ---------- aktualizacja APK ----------

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        final String url = call.getString("url");
        final long expected = longOf(call.getLong("size"));
        if (url == null || url.isEmpty()) {
            call.reject("Brak adresu aktualizacji");
            return;
        }
        new Thread(() -> {
            File out = new File(cacheDir(), "plan.apk");
            try {
                download(url, expected, out, "apk");
                install(out);
                call.resolve();
            } catch (Exception e) {
                prefs().edit().remove("restartAt").apply();
                call.reject("Nie udało się zaktualizować: " + e.getMessage());
            }
        }).start();
    }

    private void install(File apk) throws Exception {
        Context ctx = getContext();
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(ctx.getPackageName());
        params.setSize(apk.length());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) params.setInstallReason(PackageManager.INSTALL_REASON_USER);
        // Android 12+: apka aktualizująca samą siebie nie musi pytać o zgodę
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        }
        int id = pi.createSession(params);
        PackageInstaller.Session s = pi.openSession(id);
        try {
            try (InputStream in = new FileInputStream(apk); OutputStream os = s.openWrite("plan.apk", 0, apk.length())) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                s.fsync(os);
            }
            Intent i = new Intent(ctx, UpdateReceiver.class).setAction(UpdateReceiver.ACTION_STATUS);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent pending = PendingIntent.getBroadcast(ctx, id, i, flags);
            // po instalacji nowa wersja otworzy się sama (UpdateReceiver)
            prefs().edit().putLong("restartAt", System.currentTimeMillis()).commit();
            s.commit(pending.getIntentSender());
        } catch (Exception e) {
            s.abandon();
            throw e;
        } finally {
            s.close();
        }
    }

    /** Kasuje pobrane pliki aktualizacji (wołane przy starcie apki). */
    @PluginMethod
    public void cleanup(PluginCall call) {
        boolean removed = false;
        File[] files = cacheDir().listFiles();
        if (files != null) {
            for (File f : files) removed |= f.delete();
        }
        JSObject r = new JSObject();
        r.put("removed", removed);
        call.resolve(r);
    }

    // ---------- pomocnicze ----------

    private static long longOf(Long v) {
        return v != null ? v : 0L;
    }

    private void download(String url, long expected, File out, String phase) throws Exception {
        File tmp = new File(out.getParentFile(), out.getName() + ".part");
        HttpURLConnection conn = null;
        try {
            String u = url;
            boolean ok = false;
            // GitHub przekierowuje na serwer z plikami; idziemy za przekierowaniami ręcznie
            for (int i = 0; i < 6 && !ok; i++) {
                conn = (HttpURLConnection) new URL(u).openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(30000);
                conn.setRequestProperty("User-Agent", "PlanApp");
                int code = conn.getResponseCode();
                if (code >= 300 && code < 400 && conn.getHeaderField("Location") != null) {
                    u = new URL(new URL(u), conn.getHeaderField("Location")).toString();
                    conn.disconnect();
                    continue;
                }
                if (code != 200) throw new Exception("serwer odpowiedział " + code);
                ok = true;
            }
            if (!ok) throw new Exception("za dużo przekierowań");
            long total = conn.getContentLengthLong();
            if (total <= 0) total = expected;
            long done = 0;
            int lastPct = -1;
            try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(tmp)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    done += n;
                    int pct = total > 0 ? (int) (done * 100 / total) : -1;
                    if (pct != lastPct) {
                        lastPct = pct;
                        JSObject p = new JSObject();
                        p.put("phase", phase);
                        p.put("done", done);
                        p.put("total", total);
                        p.put("progress", pct);
                        notifyListeners("progress", p);
                    }
                }
            }
            if (total > 0 && done != total) throw new Exception("pobieranie się urwało");
            if (out.exists()) out.delete();
            if (!tmp.renameTo(out)) throw new Exception("nie udało się zapisać pliku");
        } catch (Exception e) {
            tmp.delete();
            throw e;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void unzip(File zip, File dest) throws Exception {
        String base = dest.getCanonicalPath() + File.separator;
        try (ZipInputStream zin = new ZipInputStream(new FileInputStream(zip))) {
            ZipEntry e;
            byte[] buf = new byte[64 * 1024];
            while ((e = zin.getNextEntry()) != null) {
                File f = new File(dest, e.getName());
                // nic poza katalogiem paczki
                if (!f.getCanonicalPath().startsWith(base)) throw new Exception("zła ścieżka w paczce");
                if (e.isDirectory()) {
                    f.mkdirs();
                    continue;
                }
                File parent = f.getParentFile();
                if (parent != null) parent.mkdirs();
                try (OutputStream os = new FileOutputStream(f)) {
                    int n;
                    while ((n = zin.read(buf)) > 0) os.write(buf, 0, n);
                }
            }
        }
    }

    private static void copyDir(File src, File dst) throws Exception {
        if (src.isDirectory()) {
            dst.mkdirs();
            File[] list = src.listFiles();
            if (list == null) return;
            for (File f : list) copyDir(f, new File(dst, f.getName()));
        } else {
            try (InputStream in = new FileInputStream(src); OutputStream os = new FileOutputStream(dst)) {
                copy(in, os);
            }
        }
    }

    private static void copyAssets(AssetManager am, String path, File dst) throws Exception {
        String[] list = am.list(path);
        if (list != null && list.length > 0) {
            dst.mkdirs();
            for (String name : list) copyAssets(am, path + "/" + name, new File(dst, name));
        } else {
            File parent = dst.getParentFile();
            if (parent != null) parent.mkdirs();
            try (InputStream in = am.open(path); OutputStream os = new FileOutputStream(dst)) {
                copy(in, os);
            }
        }
    }

    private static void copy(InputStream in, OutputStream os) throws Exception {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
    }

    static void deleteRec(File f) {
        if (f == null || !f.exists()) return;
        File[] list = f.listFiles();
        if (list != null) {
            for (File c : list) deleteRec(c);
        }
        f.delete();
    }

    private JSONObject readAssetJson(String path) {
        try (InputStream in = getContext().getAssets().open(path)) {
            return new JSONObject(readAll(in));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static JSONObject readFileJson(File f) {
        try (InputStream in = new FileInputStream(f)) {
            return new JSONObject(readAll(in));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        copy(in, bo);
        return bo.toString("UTF-8");
    }
}
