import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon";
import { colors, radii, spacing } from "../theme";

export type CreateHandlers = {
  onCamera: () => void;
  onUpload: () => void;
  onFolder: () => void;
  onDocument: () => void;
  onSpreadsheet: () => void;
};

type CreateActionsContextValue = {
  registerCreateHandlers: (handlers: CreateHandlers | null) => void;
  openCreateMenu: () => void;
};

const CreateActionsContext = createContext<CreateActionsContextValue | null>(null);

export function useCreateActions(): CreateActionsContextValue {
  const ctx = useContext(CreateActionsContext);
  if (!ctx) {
    throw new Error("useCreateActions requires CreateActionsProvider");
  }
  return ctx;
}

/** Register create handlers only while this screen is focused. */
export function useRegisterCreateHandlers(handlers: CreateHandlers | null) {
  const { registerCreateHandlers } = useCreateActions();
  const onUpload = handlers?.onUpload;
  const onCamera = handlers?.onCamera;
  const onFolder = handlers?.onFolder;
  const onDocument = handlers?.onDocument;
  const onSpreadsheet = handlers?.onSpreadsheet;

  useFocusEffect(
    useCallback(() => {
      if (!onCamera || !onUpload || !onFolder || !onDocument || !onSpreadsheet) {
        registerCreateHandlers(null);
        return () => registerCreateHandlers(null);
      }
      registerCreateHandlers({ onCamera, onUpload, onFolder, onDocument, onSpreadsheet });
      return () => registerCreateHandlers(null);
    }, [registerCreateHandlers, onCamera, onUpload, onFolder, onDocument, onSpreadsheet]),
  );
}

type ProviderProps = {
  children: React.ReactNode;
  /** Navigate to Files tab when create is requested with no active handlers. */
  onNeedFilesTab: () => void;
};

export function CreateActionsProvider({ children, onNeedFilesTab }: ProviderProps) {
  const handlersRef = useRef<CreateHandlers | null>(null);
  const pendingOpen = useRef(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const insets = useSafeAreaInsets();

  const registerCreateHandlers = useCallback((handlers: CreateHandlers | null) => {
    handlersRef.current = handlers;
    if (handlers && pendingOpen.current) {
      pendingOpen.current = false;
      setMenuVisible(true);
    }
  }, []);

  const openCreateMenu = useCallback(() => {
    if (handlersRef.current) {
      setMenuVisible(true);
      return;
    }
    pendingOpen.current = true;
    onNeedFilesTab();
  }, [onNeedFilesTab]);

  const close = () => setMenuVisible(false);

  const value = useMemo(
    () => ({ registerCreateHandlers, openCreateMenu }),
    [registerCreateHandlers, openCreateMenu],
  );

  return (
    <CreateActionsContext.Provider value={value}>
      {children}
      {menuVisible ? (
        <View style={styles.overlayWrap} pointerEvents="box-none">
          <Pressable style={styles.overlay} onPress={close} accessibilityLabel="Dismiss" />
          <View
            style={[
              styles.menu,
              {
                paddingBottom: insets.bottom + spacing.lg,
                paddingLeft: spacing.lg,
              },
            ]}
            pointerEvents="box-none"
          >
            <Pressable
              style={styles.pill}
              onPress={() => {
                close();
                handlersRef.current?.onCamera();
              }}
            >
              <Icon name="camera" size={20} color={colors.text} />
              <Text style={styles.pillText}>Camera</Text>
            </Pressable>
            <Pressable
              style={styles.pill}
              onPress={() => {
                close();
                handlersRef.current?.onDocument();
              }}
            >
              <Icon name="doc" size={20} color={colors.text} />
              <Text style={styles.pillText}>Document</Text>
            </Pressable>
            <Pressable
              style={styles.pill}
              onPress={() => {
                close();
                handlersRef.current?.onSpreadsheet();
              }}
            >
              <Icon name="sheet" size={20} color={colors.text} />
              <Text style={styles.pillText}>Spreadsheet</Text>
            </Pressable>
            <Pressable
              style={styles.pill}
              onPress={() => {
                close();
                handlersRef.current?.onUpload();
              }}
            >
              <Icon name="upload" size={20} color={colors.text} />
              <Text style={styles.pillText}>Upload</Text>
            </Pressable>
            <Pressable
              style={styles.pill}
              onPress={() => {
                close();
                handlersRef.current?.onFolder();
              }}
            >
              <Icon name="folder" size={20} color={colors.text} />
              <Text style={styles.pillText}>Folder</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </CreateActionsContext.Provider>
  );
}

const styles = StyleSheet.create({
  overlayWrap: {
    ...StyleSheet.absoluteFill,
    zIndex: 50,
    justifyContent: "flex-end",
    alignItems: "flex-start",
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.overlay,
  },
  menu: {
    gap: spacing.md,
    zIndex: 51,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: "#2B3548",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    minWidth: 132,
  },
  pillText: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 15,
  },
});
