package com.niuyin.player;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "MusicDownloads")
public class MusicDownloadsPlugin extends Plugin {
    private final ExecutorService writer = Executors.newSingleThreadExecutor();

    @PluginMethod public void pickDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        String initial = call.getString("initialUri");
        if (Build.VERSION.SDK_INT >= 26 && initial != null && DocumentsContract.isTreeUri(Uri.parse(initial))) {
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri.parse(initial));
        }
        try { startActivityForResult(call, intent, "directoryPicked"); }
        catch (RuntimeException error) { call.reject("无法打开系统文件夹选择器", error); }
    }

    @ActivityCallback private void directoryPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject cancelled = new JSObject(); cancelled.put("cancelled", true); call.resolve(cancelled); return;
        }
        Uri uri = data.getData();
        try {
            int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            if ((flags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == 0) throw new SecurityException();
            getContext().getContentResolver().takePersistableUriPermission(uri, flags);
        } catch (SecurityException error) {
            call.reject("未获得文件夹的长期写入权限，请重新选择", "DIRECTORY_PERMISSION", error); return;
        }
        writer.execute(() -> resolveDirectory(call, uri));
    }

    @PluginMethod public void getDirectoryInfo(PluginCall call) {
        String value = call.getString("uri");
        if (value == null) { call.reject("请选择下载文件夹", "DIRECTORY_PERMISSION"); return; }
        writer.execute(() -> resolveDirectory(call, Uri.parse(value)));
    }

    private void resolveDirectory(PluginCall call, Uri uri) {
        try { call.resolve(directoryInfo(uri)); }
        catch (Exception error) { call.reject("下载目录不可写，请重新选择文件夹", "DIRECTORY_PERMISSION", error); }
    }

    private JSObject directoryInfo(Uri tree) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        if (!DocumentsContract.isTreeUri(tree)) throw new SecurityException("Not a document tree");
        boolean writable = false;
        for (UriPermission permission : resolver.getPersistedUriPermissions()) {
            if (permission.getUri().equals(tree) && permission.isWritePermission()) { writable = true; break; }
        }
        if (!writable) throw new SecurityException("Directory permission revoked");
        Uri document = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
        String name;
        try (Cursor cursor = resolver.query(document, new String[] {
            DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_FLAGS
        }, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) throw new IOException("Directory no longer exists");
            name = cursor.getString(0);
            if (!DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(1)) ||
                (cursor.getLong(2) & DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE) == 0) throw new SecurityException("Read-only directory");
        }
        String displayPath = name;
        if ("com.android.externalstorage.documents".equals(tree.getAuthority())) {
            String id = DocumentsContract.getTreeDocumentId(tree);
            int colon = id.indexOf(':');
            if (colon >= 0) displayPath = (id.startsWith("primary:") ? "内部存储" : id.substring(0, colon)) + " / " + id.substring(colon + 1);
        }
        JSObject info = new JSObject(); info.put("uri", tree.toString()); info.put("name", name); info.put("displayPath", displayPath);
        return info;
    }

    @PluginMethod public void saveCachedFile(PluginCall call) {
        String directory = call.getString("directoryUri"), source = call.getString("sourceUri"), name = call.getString("name");
        String mime = call.getString("mimeType", "audio/mpeg");
        if (directory == null || source == null || !validName(name) || !mime.startsWith("audio/")) {
            call.reject("无效的下载文件参数"); return;
        }
        writer.execute(() -> {
            ContentResolver resolver = getContext().getContentResolver();
            Uri created = null;
            try {
                Uri tree = Uri.parse(directory);
                directoryInfo(tree);
                File inputFile = sourceInCache(getContext().getCacheDir(), source);
                Uri parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
                // createDocument 创建新文档；已有同名文件由系统保留并自动编号。
                created = DocumentsContract.createDocument(resolver, parent, mime, name);
                if (created == null) throw new IOException("无法创建音频文件");
                long expected = inputFile.length();
                try (InputStream input = new FileInputStream(inputFile); OutputStream output = resolver.openOutputStream(created, "w")) {
                    if (output == null) throw new IOException("无法写入下载目录");
                    if (copy(input, output) != expected) throw new IOException("音频文件未完整写入");
                }
                JSObject saved = new JSObject(); saved.put("uri", created.toString()); saved.put("name", name); call.resolve(saved);
            } catch (Exception error) {
                if (created != null) try { DocumentsContract.deleteDocument(resolver, created); } catch (Exception ignored) {}
                String message = error instanceof SecurityException ? "下载目录授权已失效，请在设置中重新选择文件夹" : "保存音乐文件失败，请检查目录权限和剩余空间";
                call.reject(message, error instanceof SecurityException ? "DIRECTORY_PERMISSION" : "DIRECTORY_WRITE_FAILED", error);
            }
        });
    }

    static boolean validName(String name) {
        return name != null && !name.trim().isEmpty() && !name.equals(".") && !name.equals("..")
            && !name.contains("/") && !name.contains("\\") && !name.contains("\0") && name.getBytes(StandardCharsets.UTF_8).length <= 255;
    }

    static File sourceInCache(File cache, String location) throws IOException {
        try {
            URI uri = URI.create(location);
            if (!"file".equals(uri.getScheme())) throw new IOException("Invalid source location");
            File source = new File(uri).getCanonicalFile();
            String root = cache.getCanonicalPath() + File.separator;
            if (!source.getPath().startsWith(root) || !source.isFile() || source.length() == 0) throw new IOException("Invalid cached audio");
            return source;
        } catch (IllegalArgumentException error) { throw new IOException("Invalid cached audio", error); }
    }

    static long copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        long written = 0;
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("Save cancelled");
            output.write(buffer, 0, count); written += count;
        }
        output.flush();
        return written;
    }

    @Override protected void handleOnDestroy() { writer.shutdownNow(); super.handleOnDestroy(); }
}
