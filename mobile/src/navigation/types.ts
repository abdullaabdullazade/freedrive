import type { NavigatorScreenParams } from "@react-navigation/native";

export type FilesStackParamList = {
  FilesHome: undefined;
  Folder: { folderId: string; title?: string };
};

export type MainTabParamList = {
  Home: undefined;
  Starred: undefined;
  Shared: undefined;
  Files:
    | {
        screen?: keyof FilesStackParamList;
        params?: FilesStackParamList[keyof FilesStackParamList];
      }
    | undefined;
};

export type RootStackParamList = {
  Login: undefined;
  TwoFactor: {
    challengeId: string;
    emailMasked: string;
    method?: string;
    methodsAvailable?: string[];
  };
  LoginApproval: { challengeId: string };
  Main: NavigatorScreenParams<MainTabParamList> | undefined;
  Search: { query: string };
  Recent: undefined;
  Activity: undefined;
  Storage: undefined;
  Offline: undefined;
  Approvals: undefined;
  Trash: undefined;
  FilePreview: {
    title: string;
    uri: string;
    mime: string;
    mode: "image" | "text" | "pdf" | "video" | "audio" | "sheet";
    text?: string;
    fileId?: string;
    gallery?: Array<{
      id: string;
      name: string;
      mime_type: string;
      iv: string;
      size?: number;
      encrypted_size?: number;
    }>;
    index?: number;
  };
};
