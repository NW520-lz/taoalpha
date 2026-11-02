using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace TaoAlpha.Native
{
    // Windows SDK UserConsentVerifierInterop.h. This is the desktop IInspectable
    // factory interface, not the UWP RequestVerificationAsync static method.
    [ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C")]
    [InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    internal interface IUserConsentVerifierInterop
    {
        [PreserveSig]
        int RequestVerificationForWindowAsync(IntPtr appWindow, IntPtr message,
            ref Guid resultInterface, out IntPtr operation);
    }

    public sealed class DesktopConsent : IDisposable
    {
        // Runtime-projected IID of IAsyncOperation<UserConsentVerificationResult>.
        // Probe compares it with the actual Windows metadata before declaring ready.
        public static readonly Guid ResultInterfaceId = new Guid("FD596FFD-2318-558F-9DBE-D21DF43764A5");
        private IUserConsentVerifierInterop factory;
        private bool initialized;

        public DesktopConsent()
        {
            Marshal.ThrowExceptionForHR(RoInitialize(0)); // RO_INIT_SINGLETHREADED; caller is -STA.
            initialized = true;
            IntPtr name = IntPtr.Zero;
            IntPtr pointer = IntPtr.Zero;
            try
            {
                const string className = "Windows.Security.Credentials.UI.UserConsentVerifier";
                Marshal.ThrowExceptionForHR(WindowsCreateString(className, className.Length, out name));
                Guid iid = typeof(IUserConsentVerifierInterop).GUID;
                Marshal.ThrowExceptionForHR(RoGetActivationFactory(name, ref iid, out pointer));
                factory = (IUserConsentVerifierInterop)Marshal.GetObjectForIUnknown(pointer);
            }
            catch { Dispose(); throw; }
            finally
            {
                if (pointer != IntPtr.Zero) Marshal.Release(pointer);
                if (name != IntPtr.Zero) WindowsDeleteString(name);
            }
        }

        public object RequestVerification(IntPtr owner, string message)
        {
            if (factory == null) throw new ObjectDisposedException("DesktopConsent");
            uint process;
            // Invalid/inactive/foreign owners are rejected before any request that
            // could show UI. An HWND must remain alive until the operation ends.
            if (owner == IntPtr.Zero || !IsWindow(owner) || !IsWindowVisible(owner) ||
                GetWindowThreadProcessId(owner, out process) == 0 ||
                process != (uint)Process.GetCurrentProcess().Id || GetForegroundWindow() != owner)
                throw new ArgumentException("A visible active local owner is required", "owner");
            if (String.IsNullOrEmpty(message)) throw new ArgumentException("A message is required", "message");
            IntPtr text = IntPtr.Zero;
            IntPtr operation = IntPtr.Zero;
            try
            {
                Marshal.ThrowExceptionForHR(WindowsCreateString(message, message.Length, out text));
                Guid iid = ResultInterfaceId;
                Marshal.ThrowExceptionForHR(factory.RequestVerificationForWindowAsync(owner, text, ref iid, out operation));
                if (operation == IntPtr.Zero) throw new InvalidOperationException("No verification operation");
                return Marshal.GetObjectForIUnknown(operation);
            }
            finally
            {
                if (operation != IntPtr.Zero) Marshal.Release(operation);
                if (text != IntPtr.Zero) WindowsDeleteString(text);
            }
        }

        public void Dispose()
        {
            if (factory != null)
            {
                Marshal.ReleaseComObject(factory);
                factory = null;
            }
            if (initialized) { RoUninitialize(); initialized = false; }
        }

        [DllImport("combase.dll")] private static extern int RoInitialize(uint mode);
        [DllImport("combase.dll")] private static extern void RoUninitialize();
        [DllImport("combase.dll", CharSet = CharSet.Unicode)]
        private static extern int WindowsCreateString(string value, int length, out IntPtr text);
        [DllImport("combase.dll")] private static extern int WindowsDeleteString(IntPtr text);
        [DllImport("combase.dll")] private static extern int RoGetActivationFactory(IntPtr name, ref Guid iid, out IntPtr factory);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    }
}
