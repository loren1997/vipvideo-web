package io.github.loren1997.vipvideoweb;

import java.util.ArrayList;
import java.util.List;

public final class EndpointPolicyTest {
    public static void main(String[] args) {
        check(EndpointPolicy.normalize(" http://192.168.1.20:3000/ ", true).equals("http://192.168.1.20:3000"));
        check(EndpointPolicy.normalize("https://home.example/", false).equals("https://home.example"));
        check(EndpointPolicy.normalize("", false).isEmpty());
        for (String invalid : new String[] { "", "file:///data/app", "content://local/item", "javascript:alert(1)", "ftp://example.com", "https://user:pass@example.com", "https://example.com?password=x", "https://example.com/#fragment", "http://example.com:99999", "http://example.com:0" }) {
            try { EndpointPolicy.normalize(invalid, true); throw new AssertionError("accepted " + invalid); }
            catch (IllegalArgumentException expected) {}
        }
        check(EndpointPolicy.sameOrigin("https://home.example", "https://HOME.example:443/#detail"));
        check(!EndpointPolicy.sameOrigin("https://home.example", "http://home.example"));
        check(!EndpointPolicy.sameOrigin("http://192.168.1.20:3000", "http://192.168.1.20:4000"));
        check(!EndpointPolicy.sameOrigin("https://home.example", "https://other.example"));
        check(!EndpointPolicy.sameOrigin("https://home.example", "content://home.example/path"));
        List<String> calls = new ArrayList<>();
        check(EndpointPolicy.select("lan", "external", true, base -> { calls.add(base); return true; }).equals("lan"));
        check(calls.equals(List.of("lan"))); calls.clear();
        check(EndpointPolicy.select("lan", "external", true, base -> { calls.add(base); return base.equals("external"); }).equals("external"));
        check(calls.equals(List.of("lan", "external"))); calls.clear();
        check(EndpointPolicy.select("lan", "external", false, base -> { calls.add(base); return true; }).equals("external"));
        check(calls.equals(List.of("external")));
        check(EndpointPolicy.select("lan", "", true, base -> false) == null);
        System.out.println("EndpointPolicy fixtures passed");
    }
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
}
