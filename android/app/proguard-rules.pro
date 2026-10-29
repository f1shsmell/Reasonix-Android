# Capacitor builds its plugin bridge by reflection, so R8 must keep the
# annotated plugin classes and the methods JS calls by name.
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod

-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.PluginMethod public *;
}
-keep class com.getcapacitor.** { *; }
-keep class com.capacitorjs.** { *; }
-keep class com.reasonix.mobile.** { *; }
-keep class org.json.** { *; }

# OkHttp is used by the native relay socket; its consumer rules cover the rest.
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.apache.**
# The barcode-scanner AAR references Gson annotations without bundling them.
-dontwarn com.google.gson.annotations.**
-dontwarn com.outsystems.**
# Its scan parameters are reflected over by the plugin; keep them even if the
# shrinker cannot see that use.
-keep class com.outsystems.** { *; }
