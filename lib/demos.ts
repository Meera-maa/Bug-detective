import type { InvestigationInput } from "./types";

export type Demo = {
  id: string;
  title: string;
  hint: string;
  input: InvestigationInput;
};

/** Three realistic bugs that the whole flow is tested against. */
export const DEMOS: Demo[] = [
  {
    id: "login-type-error",
    title: "Login TypeError",
    hint: "Reads user.name before checking that user exists",
    input: {
      language: "JavaScript",
      error: "TypeError: Cannot read properties of undefined (reading 'name')",
      stackTrace: "    at getUserName (login.js:3:15)\n    at handleLogin (login.js:9:20)",
      code: `function getUserName(data) {
  const user = data.user;
  return user.name;
}

function handleLogin(response) {
  return getUserName(response);
}`,
    },
  },
  {
    id: "api-shape",
    title: "API response mismatch",
    hint: "The API returns profile, the code expects user",
    input: {
      language: "JavaScript",
      error: `TypeError: Cannot read properties of undefined (reading 'name')

API response:
{
  "profile": {
    "name": "Meera"
  }
}`,
      stackTrace: "    at getDisplayName (profile.js:2:20)",
      code: `function getDisplayName(data) {
  return data.user.name;
}`,
    },
  },
  {
    id: "empty-input",
    title: "Empty input crash",
    hint: "A function that never validates empty input",
    input: {
      language: "JavaScript",
      error: "TypeError: Cannot read properties of undefined (reading 'toUpperCase')",
      stackTrace: "    at part (initials.js:4:23)\n    at Array.map (<anonymous>)\n    at getInitials (initials.js:4:8)",
      code: `function getInitials(fullName) {
  return fullName
    .split(" ")
    .map((part) => part[0].toUpperCase())
    .join("");
}`,
    },
  },
];
