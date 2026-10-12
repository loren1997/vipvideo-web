package io.github.loren1997.vipvideoweb;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Address validation shared with the small JDK-only fixture check. */
public final class EndpointPolicy {
    private EndpointPolicy() {}
    public interface Probe { boolean healthy(String base); }

    public static String normalize(String value, boolean required) {
        String input = value == null ? "" : value.trim();
        if (input.isEmpty()) {
            if (required) throw new IllegalArgumentException("请填写家庭局域网地址");
            return "";
        }
        try {
            URI uri = new URI(input).normalize();
            String scheme = uri.getScheme();
            if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https")) ||
                    uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null ||
                    uri.getPort() < -1 || uri.getPort() == 0 || uri.getPort() > 65535) {
                throw new IllegalArgumentException("地址必须是 HTTP/HTTPS 服务器地址，不含用户名、密码、查询参数或片段");
            }
            String path = uri.getRawPath() == null ? "" : uri.getRawPath();
            while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
            return scheme.toLowerCase(Locale.ROOT) + "://" + uri.getRawAuthority() + path;
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("地址格式无效，例如 http://192.168.1.20:3000");
        }
    }

    public static boolean isHttp(String value) {
        try {
            URI uri = new URI(value);
            return uri.getHost() != null && uri.getUserInfo() == null &&
                    ("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()));
        } catch (Exception error) { return false; }
    }

    public static boolean sameOrigin(String base, String target) {
        if (!isHttp(base) || !isHttp(target)) return false;
        try {
            URI a = new URI(base), b = new URI(target);
            return a.getScheme().equalsIgnoreCase(b.getScheme()) && a.getHost().equalsIgnoreCase(b.getHost()) && port(a) == port(b);
        } catch (URISyntaxException error) { return false; }
    }

    private static int port(URI uri) { return uri.getPort() == -1 ? ("https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80) : uri.getPort(); }

    public static String select(String lan, String external, boolean preferLan, Probe probe) {
        if (preferLan && probe.healthy(lan)) return lan;
        if (!external.isEmpty() && probe.healthy(external)) return external;
        return null;
    }
}

