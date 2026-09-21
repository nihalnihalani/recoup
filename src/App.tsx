import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell";
import Board from "./pages/Board";
import Claim from "./pages/Claim";
import Purchase from "./pages/Purchase";
import Settings from "./pages/Settings";
import SignIn from "./pages/SignIn";
import Watching from "./pages/Watching";

export default function App() {
  return (
    <>
      <AuthLoading>
        <div className="flex min-h-screen items-center justify-center bg-paper text-sm text-ink/50">
          Loading…
        </div>
      </AuthLoading>

      <Unauthenticated>
        <SignIn />
      </Unauthenticated>

      <Authenticated>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/" element={<Board />} />
            <Route path="/purchases/:id" element={<Purchase />} />
            <Route path="/claims/:id" element={<Claim />} />
            <Route path="/watching" element={<Watching />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Authenticated>
    </>
  );
}
