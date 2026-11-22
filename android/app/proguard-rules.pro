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

# The scanner decodes through MLKit's bundled implementation, which looks its
# protobuf classes up by reflection. MLKit's own consumer rule only keeps the
# FIELDS of those classes (`-keepclassmembers ... extends zzeh { <fields>; }`),
# not the classes themselves, so R8 is free to drop any it cannot see a direct
# use for. AGP 8.13's R8 happened to leave them alone; AGP 9.4.1's does not —
# and then the first analysed frame throws and OSBARCScannerActivity finishes
# at once, which reads as "scan closes immediately". Keep the whole package.
-keep class com.google.android.gms.internal.mlkit_vision_barcode_bundled.** { *; }
